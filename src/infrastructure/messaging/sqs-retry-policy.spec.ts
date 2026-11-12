import { describe, expect, it } from 'bun:test';
import { decideRetry } from './sqs-retry-policy.js';

const DEFAULT = { baseMs: 2000, capMs: 60_000 };

describe('decideRetry', () => {
  it('moves an unexpected error to the DLQ on the 3rd receive', () => {
    expect(decideRetry('unexpected', 1, DEFAULT).action).toBe('backoff');
    expect(decideRetry('unexpected', 2, DEFAULT).action).toBe('backoff');
    expect(decideRetry('unexpected', 3, DEFAULT)).toEqual({
      action: 'dlq',
      reason: 'UNEXPECTED_ERROR',
    });
  });

  it('moves contention and outages to the DLQ on the 10th receive', () => {
    for (const errorClass of ['contention', 'outage'] as const) {
      for (let receive = 1; receive <= 9; receive += 1) {
        expect(decideRetry(errorClass, receive, DEFAULT).action).toBe(
          'backoff',
        );
      }
      expect(decideRetry(errorClass, 10, DEFAULT)).toEqual({
        action: 'dlq',
        reason: 'RETRY_BUDGET_EXHAUSTED',
      });
    }
  });

  it('keeps a receive past the budget in the DLQ, such as one redriven by hand', () => {
    expect(decideRetry('contention', 49, DEFAULT).action).toBe('dlq');
    expect(decideRetry('unexpected', 7, DEFAULT).action).toBe('dlq');
  });

  it('backs off min(2 s · 2^(n − 1), 60 s) for receives 1 to 10', () => {
    const seconds = Array.from({ length: 10 }, (_, i) =>
      decideRetry('contention', i + 1, { baseMs: 2000, capMs: 60_000 }),
    ).map((decision) =>
      decision.action === 'backoff' ? decision.visibilitySeconds : 'dlq',
    );
    expect(seconds).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60, 'dlq']);
  });

  it('rounds a shortened backoff up to whole seconds, never below one', () => {
    const short = { baseMs: 100, capMs: 1000 };
    const seconds = [1, 2, 3, 4, 5, 6].map((receive) => {
      const decision = decideRetry('outage', receive, short);
      return decision.action === 'backoff' ? decision.visibilitySeconds : 0;
    });
    expect(seconds).toEqual([1, 1, 1, 1, 1, 1]);
    const decision = decideRetry('outage', 1, { baseMs: 1500, capMs: 60_000 });
    expect(decision).toEqual({ action: 'backoff', visibilitySeconds: 2 });
  });

  it('treats a missing or zero receive count as the first receive', () => {
    expect(decideRetry('unexpected', 0, DEFAULT)).toEqual({
      action: 'backoff',
      visibilitySeconds: 2,
    });
  });
});
