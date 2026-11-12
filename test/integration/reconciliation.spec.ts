/**
 * Reconciliation over HTTP against a spawned process: consistent wallets,
 * and a balance, version, or chain corrupted behind the triggers' back.
 */
import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendWins, type Row, useDatabase } from '../support/database.js';
import { brl, openWalletBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import type { ReconciliationBody } from '../support/reconcile.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('reconciliation');
const database = useDatabase(infrastructure);

let app: SpawnedApp;
let http: HttpClient;

beforeAll(async () => {
  app = await spawnApp({ env: infrastructure.env });
  http = new HttpClient(app.baseUrl);
});

afterAll(async () => {
  await app.stop();
});

async function open(amount: string): Promise<string> {
  const response = await http.post<{ id: string }>(
    '/wallets',
    openWalletBody(brl(amount)),
  );
  expect(response.status).toBe(201);
  return response.body.id;
}

const reconcile = (walletId: string) =>
  http.post<ReconciliationBody>(`/wallets/${walletId}/reconciliation`);

async function divergences(issue = 'BALANCE_MISMATCH'): Promise<number> {
  const metrics = await http.get<string>('/metrics');
  const line = metrics.body
    .split('\n')
    .find((l) =>
      l.startsWith(`reconciliation_divergences_total{issue="${issue}"}`),
    );
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

/** Runs `corrupt` as the owner with the triggers disabled. */
async function bypassTriggers(
  corrupt: (tx: SQL) => Promise<unknown>,
): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await corrupt(tx);
  });
}

/** A wallet opened at 100.00 with three 1.00 wins: versions 1 to 4, at 103.00. */
async function walletWithFourEntries(): Promise<string> {
  const walletId = await open('100.00');
  await appendWins(database.app, walletId, 3);
  return walletId;
}

describe('POST /wallets/:walletId/reconciliation', () => {
  it('reports a consistent wallet with the number of checked entries', async () => {
    const walletId = await open('100.00');
    await appendWins(database.app, walletId, 3);
    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId,
      storedBalance: brl('103.00'),
      calculatedBalance: brl('103.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 4,
      issues: [],
    });
  });

  it('reports a wallet opened at zero as consistent with no entries', async () => {
    const walletId = await open('0.00');
    const response = await reconcile(walletId);
    expect(response.body).toMatchObject({
      storedBalance: brl('0.00'),
      calculatedBalance: brl('0.00'),
      consistent: true,
      checkedEntries: 0,
    });
    await expectReconciled(http, [walletId]);
  });

  it('flags a balance corrupted behind the triggers with the signed difference, counts it, and logs it without amounts', async () => {
    const walletId = await open('100.00');
    const before = await divergences();
    await database.owner.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 90.00 WHERE id = ${walletId}`;
    });

    const response = await reconcile(walletId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId,
      storedBalance: brl('90.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('-10.00'),
      consistent: false,
      checkedEntries: 1,
      issues: [{ code: 'BALANCE_MISMATCH' }],
    });
    expect(await divergences()).toBe(before + 1);

    const warning = await waitFor(
      () =>
        app
          .output()
          .split('\n')
          .find((line) => line.includes(walletId) && line.includes('"warn"')),
      { timeoutMs: 2000, description: 'the divergence warning' },
    );
    expect(JSON.parse(warning)).toMatchObject({
      message: 'reconciliation found divergences',
      walletId,
      issues: ['BALANCE_MISMATCH'],
      checkedEntries: 1,
    });
    expect(warning).not.toMatch(/\d+\.\d{2}/);

    // Reconciliation reports; it never corrects.
    const [row] = (await database.owner`
      SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`) as Row[];
    expect(row).toEqual({ balance: '90.00' });
  });
});

describe('reconciliation issues beyond the balance', () => {
  it('flags a stored version that is not the highest entry version', async () => {
    const walletId = await walletWithFourEntries();
    const before = await divergences('VERSION_MISMATCH');
    await bypassTriggers(
      (tx) => tx`UPDATE wallets SET version = 9 WHERE id = ${walletId}`,
    );

    const response = await reconcile(walletId);
    expect(response.body).toMatchObject({
      storedBalance: brl('103.00'),
      calculatedBalance: brl('103.00'),
      consistent: false,
      checkedEntries: 4,
      issues: [
        {
          code: 'VERSION_MISMATCH',
          details: { storedVersion: 9, expectedVersion: 4 },
        },
      ],
    });
    expect(await divergences('VERSION_MISMATCH')).toBe(before + 1);
  });

  it('flags missing versions in the chain', async () => {
    const walletId = await walletWithFourEntries();
    const before = await divergences('CHAIN_GAP');
    await bypassTriggers(async (tx) => {
      await tx`UPDATE wallet_ledger_entries SET wallet_version = 6
                WHERE wallet_id = ${walletId} AND wallet_version = 4`;
      await tx`UPDATE wallets SET version = 6 WHERE id = ${walletId}`;
    });

    const response = await reconcile(walletId);
    expect(response.body).toMatchObject({
      consistent: false,
      checkedEntries: 4,
      issues: [
        {
          code: 'CHAIN_GAP',
          details: {
            expectedFirstVersion: 1,
            firstVersion: 1,
            missingVersions: [4, 5],
          },
        },
      ],
    });
    expect(await divergences('CHAIN_GAP')).toBe(before + 1);
  });

  it('flags an entry whose balance_before does not continue the previous entry', async () => {
    const walletId = await walletWithFourEntries();
    const before = await divergences('CHAIN_BREAK');
    // Shifting both balances keeps the entry's arithmetic and the ledger sum.
    await bypassTriggers(
      (tx) => tx`UPDATE wallet_ledger_entries
                    SET balance_before = balance_before + 5,
                        balance_after = balance_after + 5
                  WHERE wallet_id = ${walletId} AND wallet_version = 3`,
    );

    const response = await reconcile(walletId);
    expect(response.body).toMatchObject({
      storedBalance: brl('103.00'),
      calculatedBalance: brl('103.00'),
      consistent: false,
      checkedEntries: 4,
      issues: [
        {
          code: 'CHAIN_BREAK',
          details: { startsAtZero: true, brokenLinks: 2 },
        },
      ],
    });
    expect(await divergences('CHAIN_BREAK')).toBe(before + 1);

    const warning = await waitFor(
      () =>
        app
          .output()
          .split('\n')
          .find((line) => line.includes(walletId) && line.includes('"warn"')),
      { timeoutMs: 2000, description: 'the divergence warning' },
    );
    expect(JSON.parse(warning)).toMatchObject({ issues: ['CHAIN_BREAK'] });
  });
});
