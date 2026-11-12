/**
 * Reconciliation over HTTP against a spawned process: consistent wallets,
 * and a balance corrupted behind the triggers' back.
 */
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

async function divergences(): Promise<number> {
  const metrics = await http.get<string>('/metrics');
  const line = metrics.body
    .split('\n')
    .find((l) =>
      l.startsWith(
        'reconciliation_divergences_total{issue="BALANCE_MISMATCH"}',
      ),
    );
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
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
