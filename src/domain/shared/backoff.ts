import { InvariantViolationError } from './domain-error.js';

export type BackoffPolicy = {
  readonly baseMs: number;
  readonly capMs: number;
};

/** A source of uniform values in `[0, 1]`; `Math.random` in production. */
export type RandomSource = () => number;

/**
 * Exponential backoff with jitter, in whole milliseconds.
 *
 * The delay is `min(base · 2^(attempt − 1), cap)`, and the result is uniform
 * in `[delay / 2, delay]`.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy,
  random: RandomSource = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvariantViolationError(
      `backoff attempt must be a positive integer, got ${attempt}`,
    );
  }
  if (
    !Number.isInteger(policy.baseMs) ||
    policy.baseMs < 1 ||
    !Number.isInteger(policy.capMs) ||
    policy.capMs < policy.baseMs
  ) {
    throw new InvariantViolationError(
      'backoff policy needs integer 1 <= baseMs <= capMs',
    );
  }
  // 2^(attempt − 1) overflows to Infinity for very large attempts; min() keeps the cap.
  const delay = Math.min(policy.baseMs * 2 ** (attempt - 1), policy.capMs);
  const half = delay / 2;
  return Math.min(delay, Math.ceil(half + random() * half));
}
