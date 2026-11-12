import { describe, expect, it } from 'bun:test';
import { BulkheadFullError } from '@nestjs/resilience';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { ContentionError, OutageError } from '../../application/errors.js';
import { createPolicies, listenToPolicies } from './policies.js';

const config = { http: { bulkheadSize: 1, bulkheadQueue: 0 } };

const failWith = (error: Error) => () => Promise.reject(error);

describe('createPolicies', () => {
  it('retries Contention up to 3 attempts and nothing else', async () => {
    const { httpContentionRetry } = createPolicies(config);
    let calls = 0;
    const contention = await rejectionOf(
      httpContentionRetry(() => {
        calls += 1;
        return Promise.reject(new ContentionError('lock timeout'));
      }),
    );
    expect(contention).toBeInstanceOf(ContentionError);
    expect(calls).toBe(3);

    calls = 0;
    await rejectionOf(
      httpContentionRetry(() => {
        calls += 1;
        return Promise.reject(new OutageError('postgres', 'down'));
      }),
    );
    expect(calls).toBe(1);
  });

  it('opens the postgres circuit on five outages only and fails fast as an outage', async () => {
    const policies = createPolicies(config);
    const changes: string[] = [];
    const stop = listenToPolicies({
      bulkheadRejected: () => undefined,
      circuitChanged: (dependency, state) =>
        changes.push(`${dependency}:${state}`),
    });
    try {
      for (let i = 0; i < 10; i += 1) {
        await rejectionOf(
          policies.postgres(failWith(new ContentionError('x'))),
        );
      }
      expect(policies.circuits.postgres.state).toBe('closed');

      for (let i = 0; i < 5; i += 1) {
        await rejectionOf(
          policies.postgres(failWith(new OutageError('postgres', 'x'))),
        );
      }
      expect(policies.circuits.postgres.state).toBe('open');
      const fast = await rejectionOf(
        policies.postgres(() => Promise.resolve(1)),
      );
      expect(fast).toBeInstanceOf(OutageError);
      expect((fast as OutageError).reason).toBe('circuit open');
      expect(changes).toEqual(['postgres:open']);
    } finally {
      stop();
    }
  });

  it('reports a bulkhead rejection by group', async () => {
    const policies = createPolicies(config);
    const rejected: string[] = [];
    const stop = listenToPolicies({
      bulkheadRejected: (group) => rejected.push(group),
      circuitChanged: () => undefined,
    });
    try {
      const gate = Promise.withResolvers<void>();
      const running = policies.bulkheads.http.execute(() => gate.promise);
      expect(
        await rejectionOf(
          policies.bulkheads.http.execute(() => Promise.resolve()),
        ),
      ).toBeInstanceOf(BulkheadFullError);
      gate.resolve();
      await running;
      expect(rejected).toEqual(['http']);
    } finally {
      stop();
    }
  });
});
