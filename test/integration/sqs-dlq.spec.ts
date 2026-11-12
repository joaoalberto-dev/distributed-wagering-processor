/**
 * The application DLQ path and the receive budgets (§12) against a spawned
 * process. The backoff is shortened to whole seconds and the lock timeout to
 * 200 ms, so the budgets run out within the spec's time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { metricValue, openWallet, type Wallet } from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, keyOf, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';

/** No wallet has this ID; the fault fails every submission for it. */
const FAULTY_WALLET = Bun.randomUUIDv7();
const INSTANCE_ID = `sqs-dlq-${Bun.randomUUIDv7()}`;

const infrastructure = useInfrastructure('sqs-dlq', {
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
  app = await spawnApp({
    env: {
      ...infrastructure.env,
      INSTANCE_ID,
      FAULT_INJECTION: `unexpected-on-wallet:${FAULTY_WALLET}`,
    },
  });
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

const metric = (sample: string) => metricValue(http, sample);

describe('permanent errors', () => {
  it('moves an invalid envelope on the first receive, deduplicated by the SQS MessageId', async () => {
    const wallet = await open();
    const envelope = envelopeOf(wagerBody(wallet));
    const invalid = JSON.stringify({
      ...envelope,
      data: { ...envelope.data, note: 'x' },
    });
    const before = await metric(
      'sqs_dlq_moves_total{reason="VALIDATION_FAILED"}',
    );

    await queues.send(invalid, { groupId: wallet.id });
    await queues.send('not json', { groupId: wallet.id });

    const dead = await queues.deadLetter((m) => m.body === invalid);
    expect(dead).toMatchObject({
      failureReason: 'VALIDATION_FAILED',
      errorClass: 'permanent',
      receiveCount: 1,
      instanceId: INSTANCE_ID,
      groupId: wallet.id,
    });
    await queues.deadLetter((m) => m.body === 'not json');
    expect(
      await metric('sqs_dlq_moves_total{reason="VALIDATION_FAILED"}'),
    ).toBe(before + 2);
  });

  it('moves identity conflicts and an unknown wallet on the first receive', async () => {
    const wallet = await open();
    const first = wagerBody(wallet, { money: brl('10.00') });
    const response = await http.post('/wagering/transactions', first, {
      headers: keyOf(first),
    });
    expect(response.status).toBe(200);

    const keyConflict = envelopeOf({ ...first, money: brl('11.00') });
    const externalConflict = envelopeOf(first, {
      idempotencyKey: `another-key-${Bun.randomUUIDv7()}`,
    });
    const unknownWallet = envelopeOf(
      wagerBody({ id: Bun.randomUUIDv7(), playerId: wallet.playerId }),
    );
    for (const envelope of [keyConflict, externalConflict, unknownWallet]) {
      await queues.send(envelope);
    }

    const reasons = await Promise.all(
      [keyConflict, externalConflict, unknownWallet].map(async (envelope) => {
        const dead = await queues.deadLetter(
          (m) => m.messageId === envelope.messageId,
        );
        expect(dead.receiveCount).toBe(1);
        expect(dead.errorClass).toBe('permanent');
        return dead.failureReason;
      }),
    );
    expect(reasons).toEqual([
      'IDEMPOTENCY_KEY_CONFLICT',
      'EXTERNAL_TRANSACTION_ID_CONFLICT',
      'WALLET_NOT_FOUND',
    ]);
    await queues.drained();
    const balance = await http.get<{ balance: { amount: string } }>(
      `/wallets/${wallet.id}`,
    );
    expect(balance.body.balance.amount).toBe('90.00');
  });
});

describe('budgets', () => {
  it('moves an unexpected error on the 3rd receive as UNEXPECTED_ERROR', async () => {
    const envelope = envelopeOf(
      wagerBody({ id: FAULTY_WALLET, playerId: Bun.randomUUIDv7() }),
    );
    const before = await metric('sqs_retries_total{error_class="unexpected"}');

    await queues.send(envelope);

    const dead = await queues.deadLetter(
      (m) => m.messageId === envelope.messageId,
    );
    expect(dead).toMatchObject({
      failureReason: 'UNEXPECTED_ERROR',
      errorClass: 'unexpected',
      receiveCount: 3,
    });
    expect(await metric('sqs_retries_total{error_class="unexpected"}')).toBe(
      before + 2,
    );
    await queues.drained();
  });

  it('moves contention on the 10th receive as RETRY_BUDGET_EXHAUSTED', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { money: brl('10.00') });
    const envelope = envelopeOf(body);
    const before = await metric('sqs_retries_total{error_class="contention"}');

    // Held for the whole budget: every receive times out on the wallet lock.
    await database.owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      await queues.send(envelope);
      const dead = await queues.deadLetter(
        (m) => m.messageId === envelope.messageId,
        45_000,
      );
      expect(dead).toMatchObject({
        failureReason: 'RETRY_BUDGET_EXHAUSTED',
        errorClass: 'contention',
        receiveCount: 10,
      });
    });

    expect(await metric('sqs_retries_total{error_class="contention"}')).toBe(
      before + 9,
    );
    await queues.drained();
    const stored = await http.get(
      `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(stored.status).toBe(404);
  }, 60_000);
});
