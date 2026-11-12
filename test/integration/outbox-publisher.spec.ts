/**
 * The outbox publisher (§13, task 10).
 *
 * *   Through a spawned process with every role: each outcome publishes its
 *     events, once, with the envelope and tracing of its channel, and a
 *     replay publishes nothing.
 * *   In process, against the real database and queue: a batch whose
 *     entries 3 and 7 fail publishes the other 8 and the 2 on a later cycle;
 *     two publishers on 100 rows never send the same row.
 *
 * The in-process tests settle the events earlier specs left unpublished
 * first, so every claimed row is one of theirs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Application } from '../../src/bootstrap/container.js';
import { storedOf } from '../support/cluster.js';
import {
  newId,
  type Row,
  settlePendingEvents,
  useDatabase,
} from '../support/database.js';
import { type Delivery, EventReader } from '../support/event-reader.js';
import {
  brl,
  keyOf,
  openWalletBody,
  type WagerBody,
  wagerBody,
} from '../support/factories.js';
import { SelectiveFailingPublisher } from '../support/fakes/selective-failing-publisher.js';
import { HttpClient } from '../support/http-client.js';
import { startInProcess } from '../support/in-process.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('outbox-publisher');
const database = useDatabase(infrastructure);
const reader = new EventReader(infrastructure);

type Wallet = { id: string; playerId: string };
type Result = {
  transactionId: string;
  status: string;
  idempotentReplay: boolean;
};

/** `(eventType, data.transactionId)` of each event, sorted, to compare as a set. */
function shapes(deliveries: readonly Delivery[]): string[] {
  return deliveries
    .map((d) => `${d.event.eventType} ${String(d.event.data.transactionId)}`)
    .toSorted();
}

describe('events per outcome, through a spawned process', () => {
  let app: SpawnedApp;
  let client: HttpClient;

  beforeAll(async () => {
    app = await spawnApp({ env: infrastructure.env });
    client = new HttpClient(app.baseUrl);
  });

  afterAll(async () => {
    await app.stop();
  });

  async function post(body: WagerBody, correlationId: string): Promise<Result> {
    const response = await client.post<Result>('/wagering/transactions', body, {
      headers: { ...keyOf(body), 'x-correlation-id': correlationId },
    });
    expect([200, 202, 422]).toContain(response.status);
    return response.body;
  }

  it('publishes each outcome once with its channel tracing, and nothing for a replay', async () => {
    const opened = await client.post<Wallet>(
      '/wallets',
      openWalletBody(brl('100.00')),
    );
    expect(opened.status).toBe(201);
    const wallet = opened.body;

    const betBody = wagerBody(wallet, { money: brl('30.00') });
    const bet = await post(betBody, 'corr-bet');
    const replay = await post(betBody, 'corr-replay');
    expect(replay).toMatchObject({
      transactionId: bet.transactionId,
      idempotentReplay: true,
    });
    const loss = await post(
      wagerBody(wallet, {
        kind: 'LOSS',
        money: brl('0.00'),
        referenceExternalTransactionId: betBody.externalTransactionId,
      }),
      'corr-loss',
    );
    const rejected = await post(
      wagerBody(wallet, { money: brl('500.00') }),
      'corr-rejected',
    );
    expect(rejected.status).toBe('REJECTED');

    // A refund before its bet waits; the bet wakes it and the worker applies it.
    const lateBetBody = wagerBody(wallet, { money: brl('10.00') });
    const refundBody = wagerBody(wallet, {
      kind: 'REFUND',
      money: brl('10.00'),
      referenceExternalTransactionId: lateBetBody.externalTransactionId,
    });
    const refund = await post(refundBody, 'corr-refund');
    expect(refund.status).toBe('PENDING_REFERENCE');
    const lateBet = await post(lateBetBody, 'corr-late-bet');

    const sqsBetBody = wagerBody(wallet, { money: brl('5.00') });
    const envelope = envelopeOf(sqsBetBody);
    await new TestQueues(infrastructure).send(envelope);

    await storedOf(client, refundBody, (t) => t.status === 'PROCESSED');
    const sqsBet = await storedOf(client, sqsBetBody);

    const [{ count }] = (await database.owner`
      SELECT count(*)::int AS count FROM outbox WHERE wallet_id = ${wallet.id}`) as [
      { count: number },
    ];
    await reader.waitUntil(
      () => reader.eventsOf(wallet.id).length >= count,
      30_000,
      `${count} events of the wallet`,
    );
    const unpublished: Row[] = await database.owner`
      SELECT id FROM outbox WHERE wallet_id = ${wallet.id} AND published_at IS NULL`;
    expect(unpublished).toEqual([]);

    const events = reader.eventsOf(wallet.id);
    const opening = events.find((d) => d.event.data.kind === 'OPENING');
    if (opening === undefined) throw new Error('no OPENING event');
    const openingId = String(opening.event.data.transactionId);
    expect(shapes(events)).toEqual(
      [
        `WagerTransactionProcessed ${openingId}`,
        `WalletBalanceChanged ${openingId}`,
        `WagerTransactionProcessed ${bet.transactionId}`,
        `WalletBalanceChanged ${bet.transactionId}`,
        `WagerTransactionProcessed ${loss.transactionId}`,
        `WagerTransactionRejected ${rejected.transactionId}`,
        `WagerTransactionPendingReference ${refund.transactionId}`,
        `WagerTransactionProcessed ${refund.transactionId}`,
        `WalletBalanceChanged ${refund.transactionId}`,
        `WagerTransactionProcessed ${lateBet.transactionId}`,
        `WalletBalanceChanged ${lateBet.transactionId}`,
        `WagerTransactionProcessed ${sqsBet.id}`,
        `WalletBalanceChanged ${sqsBet.id}`,
      ].toSorted(),
    );
    expect(events).toHaveLength(count);

    for (const delivery of events) {
      expect(delivery.groupId).toBe(wallet.id);
      expect(delivery.deduplicationId).toBe(delivery.event.eventId);
      expect(delivery.event.version).toBe(1);
    }
    /** `eventType correlationId causationId` of one transaction's events, sorted. */
    const tracing = (transactionId: string): string[] =>
      events
        .filter((d) => d.event.data.transactionId === transactionId)
        .map(
          (d) =>
            `${d.event.eventType} ${d.event.correlationId} ${String(d.event.causationId)}`,
        )
        .toSorted();
    // HTTP: the X-Correlation-Id and the Idempotency-Key.
    const betKey = keyOf(betBody)['idempotency-key'];
    expect(tracing(bet.transactionId)).toEqual([
      `WagerTransactionProcessed corr-bet ${betKey}`,
      `WalletBalanceChanged corr-bet ${betKey}`,
    ]);
    // The worker: the stored correlation and the pending transaction itself.
    const refundKey = keyOf(refundBody)['idempotency-key'];
    expect(tracing(refund.transactionId)).toEqual([
      `WagerTransactionPendingReference corr-refund ${refundKey}`,
      `WagerTransactionProcessed corr-refund ${refund.transactionId}`,
      `WalletBalanceChanged corr-refund ${refund.transactionId}`,
    ]);
    // SQS: the envelope messageId for both.
    const id = envelope.messageId;
    expect(tracing(sqsBet.id)).toEqual([
      `WagerTransactionProcessed ${id} ${id}`,
      `WalletBalanceChanged ${id} ${id}`,
    ]);

    await expectReconciled(client, [wallet.id]);
  });
});

/** An event envelope as the outbox stores it, for a wallet that need not exist. */
function eventRow(walletId: string): Row {
  const id = newId();
  const occurredAt = new Date().toISOString();
  return {
    id,
    aggregate_id: walletId,
    wallet_id: walletId,
    event_type: 'WalletBalanceChanged',
    event_version: 1,
    payload: {
      eventId: id,
      eventType: 'WalletBalanceChanged',
      aggregateId: walletId,
      correlationId: 'outbox-publisher-spec',
      occurredAt,
      version: 1,
      data: { walletId },
    },
    occurred_at: occurredAt,
  };
}

/** Inserts `count` due events in one statement, so they are claimed in ID order. */
async function insertEvents(count: number): Promise<string[]> {
  const walletIds = [newId(), newId(), newId()];
  const rows = Array.from({ length: count }, (_, i) =>
    eventRow(walletIds[i % walletIds.length] ?? ''),
  );
  await database.owner`INSERT INTO outbox ${database.owner(rows)}`;
  return rows.map((row) => String(row.id));
}

type OutboxState = {
  id: string;
  published: boolean;
  attempts: number;
  last_error: string | null;
  later: boolean;
};

async function outboxStates(ids: readonly string[]): Promise<OutboxState[]> {
  return (await database.owner`
    SELECT id, published_at IS NOT NULL AS published, attempts, last_error,
           next_attempt_at > clock_timestamp() AS later
      FROM outbox WHERE id IN ${database.owner(ids)} ORDER BY id`) as OutboxState[];
}

/** An in-process application whose event publisher is wrapped by a `SelectiveFailingPublisher`. */
async function inProcess(
  delayMs = 0,
): Promise<{ app: Application; publisher: SelectiveFailingPublisher }> {
  let publisher: SelectiveFailingPublisher | undefined;
  const app = await startInProcess(infrastructure, {
    overrides: {
      wrapEventPublisher: (real) => {
        publisher = new SelectiveFailingPublisher(real, delayMs);
        return publisher;
      },
    },
  });
  if (publisher === undefined) throw new Error('the publisher was not wrapped');
  return { app, publisher };
}

describe('the publishing cycle, in process', () => {
  it('publishes 8 of 10 when entries 3 and 7 fail, and the 2 on a later cycle', async () => {
    await settlePendingEvents(database.owner);
    const { app, publisher } = await inProcess();
    try {
      const ids = (await insertEvents(10)).toSorted();
      const failed = ids.filter((_, i) => i === 2 || i === 6);
      publisher.failNext({ kind: 'entries', positions: [3, 7] });

      expect(await app.publishOutbox.runCycle()).toBe(10);

      expect(publisher.calls[0]?.map((entry) => entry.id)).toEqual(ids);
      for (const state of await outboxStates(ids)) {
        if (failed.includes(state.id)) {
          expect(state).toMatchObject({
            published: false,
            attempts: 1,
            last_error: 'InjectedFailure',
            later: true,
          });
        } else {
          expect(state).toMatchObject({ published: true, attempts: 0 });
        }
      }
      const sent = ids.filter((id) => !failed.includes(id));
      await reader.waitForIds(sent);

      // The first retry is due within 1 s.
      await waitFor(
        async () => {
          await app.publishOutbox.runCycle();
          const states = await outboxStates(ids);
          return states.every((state) => state.published);
        },
        { timeoutMs: 5000, intervalMs: 100, description: 'the 2 retries' },
      );
      const retried = publisher.calls
        .slice(1)
        .flat()
        .map((e) => e.id);
      for (const id of failed) expect(retried).toContain(id);
      await reader.waitForIds(ids);
    } finally {
      await app.close();
    }
  });

  it('never lets two publishers send the same row', async () => {
    await settlePendingEvents(database.owner);
    // Each send is held, so the two cycles overlap while their rows are locked.
    const [a, b] = await Promise.all([inProcess(30), inProcess(30)]);
    try {
      const ids = await insertEvents(100);
      const drain = async (app: Application) => {
        while ((await app.publishOutbox.runCycle()) > 0) {
          // Claim again until nothing is due for this publisher.
        }
      };
      await Promise.all([drain(a.app), drain(b.app)]);

      const sentByA = a.publisher.sentIds();
      const sentByB = b.publisher.sentIds();
      expect(sentByA.length).toBeGreaterThan(0);
      expect(sentByB.length).toBeGreaterThan(0);
      expect(sentByA.filter((id) => sentByB.includes(id))).toEqual([]);
      const all = [...sentByA, ...sentByB];
      expect(new Set(all).size).toBe(all.length);
      expect(all.toSorted()).toEqual(ids.toSorted());
      expect((await outboxStates(ids)).every((s) => s.published)).toBe(true);
      await reader.waitForIds(ids);
    } finally {
      await Promise.all([a.app.close(), b.app.close()]);
    }
  });
});
