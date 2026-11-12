import { beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryUnitOfWork } from '../../../test/support/fakes/in-memory-unit-of-work.js';
import { RecordingLogger } from '../../../test/support/fakes/recording-logger.js';
import { RecordingTelemetry } from '../../../test/support/fakes/recording-telemetry.js';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { SelectiveFailingPublisher } from '../../../test/support/fakes/selective-failing-publisher.js';
import type { OutboxMessageState } from '../../domain/messaging/outbox-message.js';
import { PublishOutbox } from './publish-outbox.js';

class Unreachable extends Error {}

let uow: InMemoryUnitOfWork;
let publisher: SelectiveFailingPublisher;
let telemetry: RecordingTelemetry;
let logger: RecordingLogger;
let publish: PublishOutbox;

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  publisher = new SelectiveFailingPublisher();
  telemetry = new RecordingTelemetry();
  logger = new RecordingLogger();
  // Jitter at its top: each delay is the full backoff.
  publish = new PublishOutbox(
    uow,
    publisher,
    uow.clock,
    telemetry,
    logger,
    10,
    () => 1,
  );
});

/** `count` unpublished events, `event-01` … , on two wallets. */
function seed(count: number): OutboxMessageState[] {
  const states = Array.from({ length: count }, (_, i): OutboxMessageState => {
    const id = `event-${String(i + 1).padStart(2, '0')}`;
    return {
      id,
      aggregateId: `transaction-${i + 1}`,
      walletId: `wallet-${(i % 2) + 1}`,
      eventType: 'WagerTransactionProcessed',
      eventVersion: 1,
      payload: { eventId: id, eventType: 'WagerTransactionProcessed' },
      occurredAt: uow.clock.now(),
      attempts: 0,
      publishedAt: null,
      lastError: null,
    };
  });
  for (const state of states) uow.store.outbox.set(state.id, state);
  return states;
}

function stored(id: string): OutboxMessageState {
  const state = uow.store.outbox.get(id);
  if (state === undefined) throw new Error(`no outbox row ${id}`);
  return state;
}

describe('PublishOutbox', () => {
  it('sends a claimed batch with the wallet as group and the envelope as body', async () => {
    const [first] = seed(2);

    expect(await publish.runCycle()).toBe(2);

    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0]?.[0]).toEqual({
      id: 'event-01',
      groupId: 'wallet-1',
      body: JSON.stringify(first?.payload),
    });
    expect(publisher.calls[0]?.[1]).toMatchObject({
      id: 'event-02',
      groupId: 'wallet-2',
    });
    expect(stored('event-01').publishedAt).toEqual(uow.clock.now());
    expect(stored('event-02').publishedAt).toEqual(uow.clock.now());
    expect(uow.runs).toEqual([{ retryContention: false }]);
    expect(telemetry.of('outboxPublishAttempt')).toEqual([['ok'], ['ok']]);
  });

  it('publishes 8 of 10 and reschedules the 2 that failed, then publishes them', async () => {
    seed(10);
    publisher.failNext({ kind: 'entries', positions: [3, 7] });

    expect(await publish.runCycle()).toBe(10);

    const failed = ['event-03', 'event-07'];
    for (const state of uow.store.outbox.values()) {
      if (failed.includes(state.id)) {
        expect(state).toMatchObject({
          publishedAt: null,
          attempts: 1,
          lastError: 'InjectedFailure',
        });
      } else {
        expect(state).toMatchObject({
          publishedAt: uow.clock.now(),
          attempts: 0,
        });
      }
    }
    expect(telemetry.of('outboxPublishAttempt')).toEqual([
      ['ok'],
      ['ok'],
      ['retry'],
      ['ok'],
      ['ok'],
      ['ok'],
      ['retry'],
      ['ok'],
      ['ok'],
      ['ok'],
    ]);
    expect(logger.errors).toEqual([]);

    expect(await publish.runCycle()).toBe(2);
    expect(publisher.calls[1]?.map((entry) => entry.id)).toEqual(failed);
    for (const id of failed) {
      expect(stored(id)).toMatchObject({
        publishedAt: uow.clock.now(),
        attempts: 1,
      });
    }
  });

  it('counts no attempt and leaves every row as it was when the whole call fails', async () => {
    const states = seed(3);
    publisher.failNext({ kind: 'call', error: new Unreachable('unreachable') });

    expect(await rejectionOf(publish.runCycle())).toBeInstanceOf(Unreachable);

    for (const state of states) expect(stored(state.id)).toEqual(state);
    expect(telemetry.calls).toEqual([]);

    expect(await publish.runCycle()).toBe(3);
    for (const state of states) {
      expect(stored(state.id)).toMatchObject({ attempts: 0, lastError: null });
    }
  });

  it('counts and logs a sender fault without the broker reason', async () => {
    seed(2);
    publisher.failNext({ kind: 'entries', positions: [2], senderFault: true });

    await publish.runCycle();

    expect(stored('event-02')).toMatchObject({
      publishedAt: null,
      attempts: 1,
    });
    expect(telemetry.of('outboxPublishAttempt')).toEqual([
      ['ok'],
      ['sender-fault'],
    ]);
    expect(logger.errors).toEqual([
      {
        message: 'outbox event refused by the broker',
        fields: {
          eventId: 'event-02',
          eventType: 'WagerTransactionProcessed',
          walletId: 'wallet-2',
          attempts: 1,
        },
      },
    ]);
  });

  it('reschedules an entry the publisher did not answer', async () => {
    seed(1);
    const silent = new PublishOutbox(
      uow,
      { publishBatch: () => Promise.resolve([]) },
      uow.clock,
      telemetry,
      logger,
    );

    await silent.runCycle();

    expect(stored('event-01')).toMatchObject({
      publishedAt: null,
      attempts: 1,
      lastError: 'no result for this entry',
    });
    expect(telemetry.of('outboxPublishAttempt')).toEqual([['retry']]);
  });

  it('claims at most one batch and calls nothing when idle', async () => {
    expect(await publish.runCycle()).toBe(0);
    expect(publisher.calls).toEqual([]);

    seed(12);
    expect(await publish.runCycle()).toBe(10);
    expect(await publish.runCycle()).toBe(2);
  });
});
