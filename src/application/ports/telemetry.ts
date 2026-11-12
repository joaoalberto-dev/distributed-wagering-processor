/** A channel through which an operation reaches the application. */
export type Channel = 'http' | 'sqs' | 'worker';

/**
 * The metrics the application raises, one method per metric (metric table).
 * Adapters own the rest: lock waits, timeouts, resilience events, and gauges.
 */
export interface Telemetry {
  transactionDecided(kind: string, status: string, channel: Channel): void;
  processingDuration(channel: Channel, seconds: number): void;
  idempotentReplay(channel: Channel): void;
  idempotencyConflict(
    code: 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  ): void;
  inboxDuplicate(): void;
  messageIdConflict(): void;
  uniqueViolationRetry(): void;
  referenceAttempt(
    outcome: 'wait' | 'processed' | 'rejected' | 'failed' | 'skipped',
  ): void;
  referenceFailed(): void;
  reconciliationDivergence(issue: string): void;
  outboxPublishAttempt(result: 'ok' | 'retry' | 'sender-fault'): void;
}

export const TELEMETRY = Symbol('Telemetry');
