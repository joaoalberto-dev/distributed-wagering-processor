import type {
  DlqReason,
  RetryClass,
} from '../../application/messaging/process-wager-message.js';

export type SqsBackoff = {
  readonly baseMs: number;
  readonly capMs: number;
};

/** The receive on which each class's budget is spent (§12, Budgets). */
export const RETRY_BUDGETS: Readonly<Record<RetryClass, number>> = {
  unexpected: 3,
  contention: 10,
  outage: 10,
};

/** What the consumer does with a message that failed with a retryable class. */
export type RetryDecision =
  | { readonly action: 'dlq'; readonly reason: DlqReason }
  | {
      readonly action: 'backoff';
      /** The new visibility timeout, in whole seconds as SQS takes it. */
      readonly visibilitySeconds: number;
    };

/**
 * Decides a retryable failure from `ApproximateReceiveCount` (tuning table):
 * the DLQ on the receive that spends the class's budget, otherwise a
 * visibility backoff of `min(base · 2^(receiveCount − 1), cap)`, rounded up
 * to whole seconds. There is no jitter: a FIFO group is blocked while its
 * message waits, so spreading retries would not spread any load.
 */
export function decideRetry(
  errorClass: RetryClass,
  receiveCount: number,
  backoff: SqsBackoff,
): RetryDecision {
  const receive = Math.max(1, Math.trunc(receiveCount));
  if (receive >= RETRY_BUDGETS[errorClass]) {
    return {
      action: 'dlq',
      reason:
        errorClass === 'unexpected'
          ? 'UNEXPECTED_ERROR'
          : 'RETRY_BUDGET_EXHAUSTED',
    };
  }
  // 2^(receive − 1) overflows to Infinity for huge counts; min() keeps the cap.
  const delayMs = Math.min(backoff.baseMs * 2 ** (receive - 1), backoff.capMs);
  return {
    action: 'backoff',
    visibilitySeconds: Math.max(1, Math.ceil(delayMs / 1000)),
  };
}
