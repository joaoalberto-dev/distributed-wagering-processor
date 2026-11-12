/**
 * Order within a `MessageGroupId` (§12) against a spawned process: messages
 * of one group apply in SQS order, a backoff releases the rest of the group
 * so it is delivered again in order, and a DLQ move lets the group go on.
 *
 * Each group is sent in one batch, so it is visible before the next receive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { metricValue, openWallet, type Wallet } from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, type WagerBody, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('sqs-ordering', {
  env: {
    SQS_BACKOFF_BASE_MS: '100',
    SQS_BACKOFF_CAP_MS: '1000',
    DB_LOCK_TIMEOUT_MS: '200',
  },
});
const database = useDatabase(infrastructure);

let app: SpawnedApp;
let http: HttpClient;
let queues: TestQueues;
const opened: string[] = [];

beforeAll(async () => {
  app = await spawnApp({ env: infrastructure.env });
  http = new HttpClient(app.baseUrl);
  queues = new TestQueues(infrastructure);
});

afterAll(async () => {
  await expectReconciled(http, opened);
  await app.stop();
});

async function open(): Promise<Wallet> {
  const wallet = await openWallet(http, '100.00');
  opened.push(wallet.id);
  return wallet;
}

type Stored = { status: string; failureCode?: string };

function stored(body: WagerBody): Promise<Stored> {
  return waitFor(
    async () => {
      const response = await http.get<Stored>(
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );
      return response.status === 200 ? response.body : undefined;
    },
    { timeoutMs: 20_000, description: body.externalTransactionId },
  );
}

/** The external IDs of the wallet's provider operations, in ledger order. */
async function ledgerOrder(wallet: Wallet): Promise<string[]> {
  const rows = (await database.owner`
    SELECT t.external_transaction_id AS id
    FROM wallet_ledger_entries e
    JOIN wager_transactions t ON t.id = e.transaction_id
    WHERE e.wallet_id = ${wallet.id} AND t.kind <> 'OPENING'
    ORDER BY e.wallet_version`) as { id: string }[];
  return rows.map((row) => row.id);
}

const metric = (sample: string) => metricValue(http, sample);

describe('ordering within a group', () => {
  it('applies WIN 50 then BET 120 on 100.00 in that order', async () => {
    const wallet = await open();
    const win = wagerBody(wallet, { kind: 'WIN', money: brl('50.00') });
    const bet = wagerBody(wallet, { money: brl('120.00') });

    await queues.sendBatch([envelopeOf(win), envelopeOf(bet)], wallet.id);

    expect((await stored(win)).status).toBe('PROCESSED');
    expect((await stored(bet)).status).toBe('PROCESSED');
    expect(await ledgerOrder(wallet)).toEqual([
      win.externalTransactionId,
      bet.externalTransactionId,
    ]);
    await queues.drained();
  });

  it('releases the siblings of a backed-off message and applies all three in order', async () => {
    const wallet = await open();
    const win = wagerBody(wallet, { kind: 'WIN', money: brl('50.00') });
    const bet = wagerBody(wallet, { money: brl('120.00') });
    const last = wagerBody(wallet, { money: brl('30.00') });
    const before = await metric('sqs_retries_total{error_class="contention"}');

    await database.owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      await queues.sendBatch(
        [envelopeOf(win), envelopeOf(bet), envelopeOf(last)],
        wallet.id,
      );
      // The first message times out on the lock and is backed off.
      await waitFor(
        async () =>
          (await metric('sqs_retries_total{error_class="contention"}')) >
          before,
        { timeoutMs: 10_000, description: 'a contention backoff' },
      );
    });

    for (const body of [win, bet, last]) {
      expect((await stored(body)).status).toBe('PROCESSED');
    }
    expect(await ledgerOrder(wallet)).toEqual([
      win.externalTransactionId,
      bet.externalTransactionId,
      last.externalTransactionId,
    ]);
    await queues.drained();
    expect(
      (await queues.deadLetters()).filter((m) => m.groupId === wallet.id),
    ).toEqual([]);
  });

  it('goes on with the group after a DLQ move, without releasing it', async () => {
    const wallet = await open();
    const unknownWallet = envelopeOf(
      wagerBody({ id: Bun.randomUUIDv7(), playerId: wallet.playerId }),
    );
    const invalid = JSON.stringify({
      ...envelopeOf(wagerBody(wallet)),
      type: 'Other',
    });
    const bet = wagerBody(wallet, { money: brl('10.00') });
    const retries = await metric('sqs_retries_total{error_class="contention"}');

    await queues.sendBatch(
      [invalid, unknownWallet, envelopeOf(bet)],
      wallet.id,
    );

    expect((await stored(bet)).status).toBe('PROCESSED');
    const moved = [
      await queues.deadLetter((m) => m.body === invalid),
      await queues.deadLetter((m) => m.messageId === unknownWallet.messageId),
    ];
    // A release would have cost the later messages another receive.
    expect(moved.map((m) => [m.failureReason, m.receiveCount])).toEqual([
      ['VALIDATION_FAILED', 1],
      ['WALLET_NOT_FOUND', 1],
    ]);
    expect(await metric('sqs_retries_total{error_class="contention"}')).toBe(
      retries,
    );
    await queues.drained();
  });
});
