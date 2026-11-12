/**
 * The inbox against a spawned process (§10, §12): repeated and conflicting
 * deliveries of one envelope `messageId`, concurrent deliveries, and the
 * same operation sent over HTTP and then SQS.
 *
 * Concurrent deliveries use different `MessageGroupId`s, so the consumer
 * runs them in parallel; whichever order they take, the outcome is the same.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { metricValue, openWallet, type Wallet } from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, keyOf, type WagerBody, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

// Long enough for the race test to queue two lock waiters behind the test's lock.
const infrastructure = useInfrastructure('inbox-redelivery', {
  env: { DB_LOCK_TIMEOUT_MS: '8000' },
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

async function open(amount = '100.00'): Promise<Wallet> {
  const wallet = await openWallet(http, amount);
  opened.push(wallet.id);
  return wallet;
}

type Stored = { id: string; status: string; balance: { amount: string } };

/** The stored transaction of `body`, once it exists. */
function stored(body: WagerBody): Promise<Stored> {
  return waitFor(
    async () => {
      const response = await http.get<Stored>(
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );
      return response.status === 200 ? response.body : undefined;
    },
    { timeoutMs: 15_000, description: `${body.externalTransactionId}` },
  );
}

async function balanceOf(wallet: Wallet): Promise<string> {
  const response = await http.get<{ balance: { amount: string } }>(
    `/wallets/${wallet.id}`,
  );
  return response.body.balance.amount;
}

async function inboxRows(messageId: string) {
  return (await database.owner`
    SELECT transaction_id FROM inbox WHERE message_id = ${messageId}`) as {
    transaction_id: string;
  }[];
}

const metric = (sample: string) => metricValue(http, sample);

describe('inbox redelivery', () => {
  it('acks a repeated delivery as a duplicate with one effect', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { money: brl('10.00') });
    const envelope = envelopeOf(body);
    const before = await metric('inbox_duplicates_total');

    await queues.send(envelope);
    await stored(body);
    await queues.send(envelope);

    await waitFor(
      async () => (await metric('inbox_duplicates_total')) === before + 1,
      { timeoutMs: 15_000, description: 'the duplicate to be counted' },
    );
    await queues.drained();
    expect(await balanceOf(wallet)).toBe('90.00');
    expect(await inboxRows(envelope.messageId)).toHaveLength(1);
  });

  it('moves the same messageId with another payload to the DLQ as MESSAGE_ID_CONFLICT', async () => {
    const wallet = await open();
    const first = wagerBody(wallet, { money: brl('10.00') });
    const envelope = envelopeOf(first);
    const before = await metric('message_id_conflicts_total');

    await queues.send(envelope);
    await stored(first);
    const other = envelopeOf(wagerBody(wallet, { money: brl('20.00') }), {
      messageId: envelope.messageId,
    });
    await queues.send(other);

    const dead = await queues.deadLetter(
      (m) => m.messageId === envelope.messageId,
    );
    expect(dead).toMatchObject({
      failureReason: 'MESSAGE_ID_CONFLICT',
      errorClass: 'permanent',
      receiveCount: 1,
      groupId: wallet.id,
    });
    expect(JSON.parse(dead.body)).toEqual(other);
    expect(await metric('message_id_conflicts_total')).toBe(before + 1);
    expect(await balanceOf(wallet)).toBe('90.00');
  });

  it('gives one effect and one inbox row for two concurrent deliveries of the same message', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { money: brl('10.00') });
    const envelope = envelopeOf(body);

    await Promise.all([
      queues.send(envelope, { groupId: `${wallet.id}-a` }),
      queues.send(envelope, { groupId: `${wallet.id}-b` }),
    ]);

    await stored(body);
    await queues.drained();
    expect(await balanceOf(wallet)).toBe('90.00');
    expect(await inboxRows(envelope.messageId)).toHaveLength(1);
  });

  it('gives one effect and one DLQ message for two concurrent deliveries with different payloads', async () => {
    const wallet = await open();
    const a = wagerBody(wallet, { money: brl('10.00') });
    const b = wagerBody(wallet, { money: brl('20.00') });
    const messageId = `msg-${Bun.randomUUIDv7()}`;

    await Promise.all([
      queues.send(envelopeOf(a, { messageId }), { groupId: `${wallet.id}-a` }),
      queues.send(envelopeOf(b, { messageId }), { groupId: `${wallet.id}-b` }),
    ]);

    const dead = await queues.deadLetter((m) => m.messageId === messageId);
    expect(dead.failureReason).toBe('MESSAGE_ID_CONFLICT');
    await queues.drained();
    const rows = await inboxRows(messageId);
    expect(rows).toHaveLength(1);
    const winner = JSON.parse(dead.body) as { data: WagerBody };
    const applied =
      winner.data.externalTransactionId === a.externalTransactionId ? b : a;
    const transaction = await stored(applied);
    expect(rows[0]?.transaction_id).toBe(transaction.id);
    expect(await balanceOf(wallet)).toBe(applied === a ? '90.00' : '80.00');
    expect(
      (await queues.deadLetters()).filter((m) => m.messageId === messageId),
    ).toHaveLength(1);
  });

  it('answers SQS after HTTP with the same key as a replay and records the delivery', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { money: brl('10.00') });
    const response = await http.post<{ transactionId: string }>(
      '/wagering/transactions',
      body,
      { headers: keyOf(body) },
    );
    expect(response.status).toBe(200);
    const before = await metric('idempotent_replays_total{channel="sqs"}');

    const envelope = envelopeOf(body);
    await queues.send(envelope);

    await waitFor(
      async () => (await inboxRows(envelope.messageId)).length > 0,
      {
        timeoutMs: 15_000,
        description: 'the inbox row',
      },
    );
    expect(await inboxRows(envelope.messageId)).toEqual([
      { transaction_id: response.body.transactionId },
    ]);
    expect(await metric('idempotent_replays_total{channel="sqs"}')).toBe(
      before + 1,
    );
    await queues.drained();
    expect(await balanceOf(wallet)).toBe('90.00');
  });

  it('records the inbox row against the HTTP commit that lands between the lookup and the lock', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { money: brl('10.00') });
    const envelope = envelopeOf(body);
    const waiters = async () => {
      const [row] = (await database.owner`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`) as {
        n: number;
      }[];
      return row?.n ?? 0;
    };

    // Wrapped, so the transaction does not wait for the response it holds up.
    const { pending } = await database.owner.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      // HTTP queues on the wallet lock first, then the SQS delivery behind it.
      const pending = http.post<{ transactionId: string }>(
        '/wagering/transactions',
        body,
        { headers: keyOf(body) },
      );
      await waitFor(async () => (await waiters()) === 1, {
        timeoutMs: 5000,
        description: 'the HTTP request to wait on the wallet lock',
      });
      await queues.send(envelope);
      await waitFor(async () => (await waiters()) === 2, {
        timeoutMs: 5000,
        description: 'the SQS delivery to wait on the wallet lock',
      });
      return { pending };
    });

    const response = await pending;
    expect(response.status).toBe(200);
    await waitFor(
      async () => (await inboxRows(envelope.messageId)).length > 0,
      {
        timeoutMs: 15_000,
        description: 'the inbox row',
      },
    );
    expect(await inboxRows(envelope.messageId)).toEqual([
      { transaction_id: response.body.transactionId },
    ]);
    const transactions: unknown[] = await database.owner`
      SELECT id FROM wager_transactions
      WHERE provider_id = ${body.providerId}
        AND external_transaction_id = ${body.externalTransactionId}`;
    expect(transactions).toHaveLength(1);
    await queues.drained();
    expect(await balanceOf(wallet)).toBe('90.00');
  });
});
