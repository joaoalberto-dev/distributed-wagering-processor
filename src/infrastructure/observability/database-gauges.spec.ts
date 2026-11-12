import { describe, expect, it } from 'bun:test';
import { DatabaseGauges, type GaugeSources } from './database-gauges.js';
import { Metrics } from './metrics.js';

const BACKLOG = {
  outboxPending: 7,
  outboxLagSeconds: 12.5,
  pendingReferences: 3,
};

function sources(overrides: Partial<GaugeSources> = {}): GaugeSources {
  return {
    backlog: () => Promise.resolve(BACKLOG),
    dlqDepth: () => Promise.resolve(2),
    pool: () => Promise.resolve({ inUse: 4, waiting: 1 }),
    ...overrides,
  };
}

describe('DatabaseGauges', () => {
  it('sets every gauge on an instance that reads the shared state', async () => {
    const metrics = new Metrics();
    await new DatabaseGauges({
      sources: sources(),
      registry: metrics.registry,
      readShared: true,
    }).refresh();

    const text = await metrics.render();
    expect(text).toContain('outbox_pending 7');
    expect(text).toContain('outbox_lag_seconds 12.5');
    expect(text).toContain('pending_references 3');
    expect(text).toContain('sqs_dlq_depth 2');
    expect(text).toContain('db_pool_in_use 4');
    expect(text).toContain('db_pool_waiting 1');
  });

  it('reads only its own pool when it runs neither the publisher nor the worker', async () => {
    const metrics = new Metrics();
    let shared = 0;
    await new DatabaseGauges({
      sources: sources({
        backlog: () => {
          shared += 1;
          return Promise.resolve(BACKLOG);
        },
        dlqDepth: () => {
          shared += 1;
          return Promise.resolve(0);
        },
      }),
      registry: metrics.registry,
      readShared: false,
    }).refresh();

    const text = await metrics.render();
    expect(shared).toBe(0);
    expect(text).toContain('db_pool_in_use 4');
    expect(text).not.toMatch(/^outbox_pending /m);
    expect(text).not.toMatch(/^sqs_dlq_depth /m);
  });

  it('reports a read that fails or times out as NaN, and still answers', async () => {
    const metrics = new Metrics();
    let aborted = false;
    await new DatabaseGauges({
      sources: sources({
        backlog: () => Promise.reject(new Error('connection refused')),
        dlqDepth: (signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve(9);
            });
          }),
      }),
      registry: metrics.registry,
      readShared: true,
      timeoutMs: 20,
    }).refresh();

    // prom-client prints `Nan`; Prometheus parses NaN in any case.
    const text = await metrics.render();
    expect(aborted).toBe(true);
    expect(text).toMatch(/^outbox_pending nan$/im);
    expect(text).toMatch(/^outbox_lag_seconds nan$/im);
    expect(text).toMatch(/^pending_references nan$/im);
    expect(text).toMatch(/^sqs_dlq_depth nan$/im);
    expect(text).toContain('db_pool_in_use 4');
  });
});
