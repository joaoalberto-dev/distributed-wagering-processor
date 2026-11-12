import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Infrastructure } from './infrastructure.js';
import { waitFor } from './wait-for.js';

/** An integration event envelope as published (§13). */
export type PublishedEvent = {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
};

/** One delivery from the events queue. */
export type Delivery = {
  readonly body: string;
  readonly event: PublishedEvent;
  readonly groupId: string | undefined;
  readonly deduplicationId: string | undefined;
};

/**
 * The spec's events queue, read the way a consumer would: every delivery
 * is kept, and `events()` removes duplicates by `eventId`. Messages are
 * deleted as they are read, so a FIFO group never hides the next one.
 */
export class EventReader {
  readonly #deliveries: Delivery[] = [];

  constructor(private readonly infrastructure: Infrastructure) {}

  /** Every delivery so far, duplicates included. */
  get deliveries(): readonly Delivery[] {
    return this.#deliveries;
  }

  /** One short receive; returns how many messages it read. */
  async poll(): Promise<number> {
    const queueUrl = this.infrastructure.queueUrls.events;
    const { Messages } = await this.infrastructure.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: [
          'MessageGroupId',
          'MessageDeduplicationId',
        ],
      }),
    );
    const messages = Messages ?? [];
    if (messages.length === 0) return 0;
    for (const message of messages) {
      const body = message.Body ?? '';
      this.#deliveries.push({
        body,
        event: JSON.parse(body) as PublishedEvent,
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
      });
    }
    await this.infrastructure.sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle,
        })),
      }),
    );
    return messages.length;
  }

  /**
   * The distinct events, by `eventId`, in first-delivery order. A repeated
   * delivery must carry the same body: that is what makes it safe to drop.
   */
  events(): Delivery[] {
    const byId = new Map<string, Delivery>();
    for (const delivery of this.#deliveries) {
      const first = byId.get(delivery.event.eventId);
      if (first === undefined) {
        byId.set(delivery.event.eventId, delivery);
      } else if (first.body !== delivery.body) {
        throw new Error(
          `event ${delivery.event.eventId} was delivered with two bodies`,
        );
      }
    }
    return [...byId.values()];
  }

  /** The distinct events of one wallet (its FIFO group). */
  eventsOf(walletId: string): Delivery[] {
    return this.events().filter((delivery) => delivery.groupId === walletId);
  }

  /** Reads until every one of `eventIds` has arrived. */
  async waitForIds(
    eventIds: Iterable<string>,
    timeoutMs = 30_000,
  ): Promise<void> {
    const wanted = new Set(eventIds);
    await this.waitUntil(
      (events) => {
        const seen = new Set(events.map((d) => d.event.eventId));
        return [...wanted].every((id) => seen.has(id));
      },
      timeoutMs,
      `${wanted.size} events`,
    );
  }

  /** Reads until `done` accepts the distinct events so far. */
  async waitUntil(
    done: (events: Delivery[]) => boolean,
    timeoutMs = 30_000,
    description = 'the expected events',
  ): Promise<void> {
    await waitFor(
      async () => {
        if (done(this.events())) return true;
        await this.poll();
        return done(this.events());
      },
      { timeoutMs, intervalMs: 0, description },
    );
  }
}
