import type { IntegrationEvent } from '../events/integration-event.js';
import {
  backoffDelay,
  type BackoffPolicy,
  type RandomSource,
} from '../shared/backoff.js';
import { InvalidTransitionError } from '../shared/domain-error.js';

/** The publish retry backoff: base 1 s, cap 5 min, retried forever. */
export const OUTBOX_BACKOFF: BackoffPolicy = { baseMs: 1000, capMs: 300_000 };

export type OutboxMessageState = {
  /** The event's `eventId`. */
  readonly id: string;
  readonly aggregateId: string;
  /** The FIFO group key of the events queue. */
  readonly walletId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly publishedAt: Date | null;
  readonly lastError: string | null;
};

/**
 * An integration event waiting for publication, written in the same SQL
 * transaction as the outcome it records. There is no dead-letter state: a
 * failed send is retried with backoff until it succeeds, and a published
 * message never changes again.
 */
export class OutboxMessage {
  private constructor(private state: OutboxMessageState) {}

  static enqueue(
    event: IntegrationEvent<{ readonly walletId: string }>,
  ): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      walletId: event.data.walletId,
      eventType: event.eventType,
      eventVersion: event.version,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      publishedAt: null,
      lastError: null,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id(): string {
    return this.state.id;
  }
  get aggregateId(): string {
    return this.state.aggregateId;
  }
  get walletId(): string {
    return this.state.walletId;
  }
  get eventType(): string {
    return this.state.eventType;
  }
  get eventVersion(): number {
    return this.state.eventVersion;
  }
  get payload(): Readonly<Record<string, unknown>> {
    return this.state.payload;
  }
  get occurredAt(): Date {
    return this.state.occurredAt;
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get publishedAt(): Date | null {
    return this.state.publishedAt;
  }
  get lastError(): string | null {
    return this.state.lastError;
  }

  isPublished(): boolean {
    return this.state.publishedAt !== null;
  }

  markPublished(at: Date): void {
    this.assertUnpublished('PUBLISHED');
    this.state = { ...this.state, publishedAt: at };
  }

  /**
   * Counts a failed send and returns the delay until the next attempt; the
   * repository turns it into a time with the database clock.
   */
  scheduleRetry(error: string, random?: RandomSource): number {
    this.assertUnpublished('RETRY');
    const attempts = this.state.attempts + 1;
    this.state = { ...this.state, attempts, lastError: error };
    return backoffDelay(attempts, OUTBOX_BACKOFF, random);
  }

  toState(): OutboxMessageState {
    return { ...this.state };
  }

  private assertUnpublished(to: string): void {
    if (this.state.publishedAt !== null) {
      throw new InvalidTransitionError('PUBLISHED', to);
    }
  }
}
