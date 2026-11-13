/**
 * The application DLQ path and the receive budgets (§12) against a spawned
 * process. The backoff is shortened to whole seconds and the lock timeout to
 * 200 ms, so the budgets run out within the spec's time.
 */
import {
  ChangeMessageVisibilityCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { SqsDlqMover } from '../../src/infrastructure/messaging/sqs-dlq-mover.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { metricValue, openWallet, type Wallet } from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, keyOf, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { rejectionOf } from '../support/rejection-of.js';
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
const moveInfrastructure = useInfrastructure('dlq-delete-retry');

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

  it('preserves both conflicting deliveries for the same envelope ID', async () => {
    const wallet = await open();
    const first = envelopeOf(wagerBody(wallet, { money: brl('1.00') }));
    const conflicts = ['2.00', '3.00'].map((amount) =>
      JSON.stringify({ ...first, data: { ...first.data, money: brl(amount) } }),
    );
    await queues.sendBatch([first, ...conflicts], wallet.id);
    for (const body of conflicts) {
      expect(
        await queues.deadLetter((message) => message.body === body),
      ).toMatchObject({
        body,
        groupId: wallet.id,
        failureReason: 'MESSAGE_ID_CONFLICT',
        instanceId: INSTANCE_ID,
        errorClass: 'permanent',
      });
    }
    await queues.drained();
    const [row] = (await database.app`
      SELECT balance::text, version, (SELECT count(*)::int
        FROM wallet_ledger_entries WHERE wallet_id = wallets.id) AS entries
      FROM wallets WHERE id = ${wallet.id}`) as {
      balance: string;
      version: number;
      entries: number;
    }[];
    expect(row).toEqual({ balance: '99.00', version: 2, entries: 2 });
    await expectReconciled(http, [wallet.id]);
  });

  it('can resend after an accepted DLQ send and a failed source delete', async () => {
    const { sqs, queueUrls } = moveInfrastructure;
    const moveQueues = new TestQueues(moveInfrastructure);
    const body = 'invalid envelope awaiting source deletion';
    const id = await moveQueues.send(body);
    const receive = async () => {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrls.input,
          WaitTimeSeconds: 2,
          VisibilityTimeout: 10,
        }),
      );
      const message = result.Messages?.[0];
      if (message === undefined) throw new Error('No source delivery received');
      expect(message.MessageId).toBe(id);
      return message;
    };
    const original = await receive();
    let sends = 0;
    let injectFailure = true;
    const mover = new SqsDlqMover({
      sqs,
      queues: { url: (name) => Promise.resolve(queueUrls[name]) },
      instanceId: INSTANCE_ID,
      guard: (call) => {
        if (sends === 1 && injectFailure) {
          injectFailure = false;
          return Promise.reject(new Error('injected delete failure'));
        }
        return call();
      },
      onMoved: () => {
        sends += 1;
      },
    });
    const move = {
      groupId: 'raw',
      reason: 'VALIDATION_FAILED',
      errorClass: 'permanent',
    } as const;
    expect(
      await rejectionOf(
        mover.move({ ...move, message: original, receiveCount: 1 }),
      ),
    ).toEqual(new Error('injected delete failure'));
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrls.input,
        ReceiptHandle: original.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    await mover.move({ ...move, message: await receive(), receiveCount: 2 });
    await moveQueues.drained();
    expect(sends).toBe(2);
    expect(await moveQueues.deadLetters()).toMatchObject([
      {
        body,
        groupId: 'raw',
        receiveCount: 1,
        failureReason: 'VALIDATION_FAILED',
      },
    ]);
    expect(await moveQueues.deadLetters()).toHaveLength(1);
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
