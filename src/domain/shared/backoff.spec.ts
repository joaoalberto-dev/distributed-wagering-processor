import { describe, expect, it } from 'bun:test';
import { backoffDelay } from './backoff.js';
import { InvariantViolationError } from './domain-error.js';

const policy = { baseMs: 1000, capMs: 300_000 };

describe('backoffDelay', () => {
  it('gives a delay in [base/2, base] on the first attempt', () => {
    expect(backoffDelay(1, policy, () => 0)).toBe(500);
    expect(backoffDelay(1, policy, () => 1)).toBe(1000);
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelay(1, policy);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it('doubles the delay per attempt', () => {
    const full = [1, 2, 3, 4, 5].map((attempt) =>
      backoffDelay(attempt, policy, () => 1),
    );
    expect(full).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it('holds the cap at attempt 20 and beyond', () => {
    expect(backoffDelay(20, policy, () => 1)).toBe(300_000);
    expect(backoffDelay(20, policy, () => 0)).toBe(150_000);
    expect(backoffDelay(5000, policy, () => 1)).toBe(300_000);
  });

  it('gives a fixed value for a fixed random source', () => {
    expect(backoffDelay(3, policy, () => 0.5)).toBe(3000);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(3000);
  });

  it('rejects a non-positive or fractional attempt and an inverted policy', () => {
    expect(() => backoffDelay(0, policy)).toThrow(InvariantViolationError);
    expect(() => backoffDelay(1.5, policy)).toThrow(InvariantViolationError);
    expect(() => backoffDelay(1, { baseMs: 10, capMs: 5 })).toThrow(
      InvariantViolationError,
    );
  });
});
