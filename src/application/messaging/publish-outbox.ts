import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { RandomSource } from '../../domain/shared/backoff.js';
import type { Clock } from '../ports/clock.js';
import type {
  EventPublisher,
  PublishResult,
} from '../ports/event-publisher.js';
import type { AppLogger } from '../ports/logger.js';
import type { Telemetry } from '../ports/telemetry.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The publisher's batch from the tuning table: one `SendMessageBatch`. */
export const OUTBOX_BATCH_SIZE = 10;

/** The reason kept for an entry the publisher did not answer. */
const NO_RESULT = 'no result for this entry';

/** How one claimed row ended, recorded after the commit. */
type Sent = {
  readonly message: OutboxMessage;
  readonly result: PublishResult | undefined;
};

/**
 * One cycle of the outbox publisher (§13), in one short transaction:
 *
 * 1. claim up to 10 due, unpublished rows with `FOR UPDATE SKIP LOCKED`, so
 *    concurrent publishers get disjoint sets;
 * 2. send them in one call, inside the transaction;
 * 3. record each entry through the domain `OutboxMessage`: `markPublished`
 *    when it was sent, `scheduleRetry` (attempts + 1, backoff) when it was
 *    not;
 * 4. commit.
 *
 * If the call throws, the transaction rolls back and no attempt is counted;
 * the `sqs` circuit records the failure. A crash during the send releases
 * the row locks at once, and the next cycle anywhere republishes the same
 * `eventId`. There is no dead-letter state: a failing event is retried
 * forever with a backoff capped at 5 minutes.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
    private readonly logger: AppLogger,
    private readonly batchSize: number = OUTBOX_BATCH_SIZE,
    private readonly random: RandomSource = Math.random,
  ) {}

  /** Runs one cycle and returns how many rows it claimed; zero means idle. */
  async runCycle(): Promise<number> {
    const sent = await this.unitOfWork.run(
      async (tx) => {
        const messages = await tx.outbox.claimDue(this.batchSize);
        if (messages.length === 0) return [];
        const results = await this.publisher.publishBatch(
          messages.map((message) => ({
            id: message.id,
            groupId: message.walletId,
            body: JSON.stringify(message.payload),
          })),
        );
        const byId = new Map(results.map((result) => [result.id, result]));
        const now = this.clock.now();
        const published: string[] = [];
        const outcome: Sent[] = [];
        for (const message of messages) {
          const result = byId.get(message.id);
          if (result?.ok === true) {
            message.markPublished(now);
            published.push(message.id);
          } else {
            const error = result?.error ?? NO_RESULT;
            const delay = message.scheduleRetry(error, this.random);
            await tx.outbox.scheduleRetry(message.id, delay, error);
          }
          outcome.push({ message, result });
        }
        await tx.outbox.markPublished(published);
        return outcome;
      },
      { retryContention: false },
    );
    for (const entry of sent) this.record(entry);
    return sent.length;
  }

  /** Metrics and logs, after the commit. */
  private record({ message, result }: Sent): void {
    if (result?.ok === true) {
      this.telemetry.outboxPublishAttempt('ok');
      return;
    }
    if (result?.senderFault === true) {
      this.telemetry.outboxPublishAttempt('sender-fault');
      // The broker's reason stays in `last_error`: its text may quote the body.
      this.logger.error('outbox event refused by the broker', {
        eventId: message.id,
        eventType: message.eventType,
        walletId: message.walletId,
        attempts: message.attempts,
      });
      return;
    }
    this.telemetry.outboxPublishAttempt('retry');
  }
}
