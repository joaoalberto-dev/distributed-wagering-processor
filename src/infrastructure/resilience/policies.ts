import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  CircuitOpenError,
  type CircuitState,
  type ResilienceEvent,
  RetryPolicy,
} from '@nestjs/resilience';
import { ContentionError, OutageError } from '../../application/errors.js';
import type { AppConfig } from '../config/app-config.js';
import type { CallGuard } from '../persistence/mikro-orm-unit-of-work.js';

/** The route groups with their own bulkhead (connection budget, §10). */
export type BulkheadGroup = 'http' | 'reconciliation' | 'readiness';

export type Dependency = 'postgres';

/**
 * The named policies of one process (tuning table). Every caller of a
 * dependency shares its circuit, and every route of a group shares its
 * bulkhead.
 */
export type Policies = {
  /** HTTP only: 3 attempts in total, full jitter from 50 ms, Contention only. */
  readonly httpContentionRetry: CallGuard;
  readonly bulkheads: Readonly<Record<BulkheadGroup, BulkheadPolicy>>;
  readonly circuits: Readonly<Record<Dependency, CircuitBreakerPolicy>>;
  /** Runs a call through the `postgres` circuit; an open circuit is an outage. */
  readonly postgres: CallGuard;
};

export function createPolicies(config: Pick<AppConfig, 'http'>): Policies {
  const retry = new RetryPolicy({
    name: 'http-contention',
    attempts: 3,
    backoff: { delay: 50, jitter: 'full' },
    retryIf: (error) => error instanceof ContentionError,
  });
  const postgres = new CircuitBreakerPolicy({
    name: 'postgres',
    // Five consecutive outages: every recorded call in a window of five failed.
    failureRateThreshold: 100,
    minimumCalls: 5,
    slidingWindow: { type: 'count', size: 5 },
    openDuration: '5s',
    halfOpenMaxCalls: 1,
    // Contention on a hot wallet must never open it.
    recordIf: (error) => error instanceof OutageError,
  });
  return {
    httpContentionRetry: (call) => retry.execute(() => call()),
    bulkheads: {
      http: new BulkheadPolicy({
        name: 'http',
        maxConcurrent: config.http.bulkheadSize,
        maxQueue: config.http.bulkheadQueue,
        queueTimeout: '2s',
      }),
      reconciliation: new BulkheadPolicy({
        name: 'reconciliation',
        maxConcurrent: 2,
        maxQueue: 10,
        queueTimeout: '2s',
      }),
      readiness: new BulkheadPolicy({
        name: 'readiness',
        maxConcurrent: 1,
        maxQueue: 5,
        queueTimeout: '1s',
      }),
    },
    circuits: { postgres },
    postgres: async (call) => {
      try {
        return await postgres.execute(() => call());
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          throw new OutageError('postgres', 'circuit open', { cause: error });
        }
        throw error;
      }
    },
  };
}

/** What the metrics adapter needs to know about the policies' events. */
export type PolicyListener = {
  bulkheadRejected(group: BulkheadGroup): void;
  circuitChanged(dependency: Dependency, state: CircuitState): void;
};

const GROUPS: ReadonlySet<string> = new Set<BulkheadGroup>([
  'http',
  'reconciliation',
  'readiness',
]);
const DEPENDENCIES: ReadonlySet<string> = new Set<Dependency>(['postgres']);

/**
 * Listens to the policies' events on the `nestjs:resilience:*` diagnostics
 * channels, where policies created with `new` publish them. Returns the
 * function that stops listening.
 */
export function listenToPolicies(listener: PolicyListener): () => void {
  const handlers: [string, (message: unknown) => void][] = [
    [
      'nestjs:resilience:bulkhead-rejected',
      (message) => {
        const event = message as ResilienceEvent;
        if (GROUPS.has(event.policy)) {
          listener.bulkheadRejected(event.policy as BulkheadGroup);
        }
      },
    ],
    ...(['circuit-open', 'circuit-half-open', 'circuit-closed'] as const).map(
      (type): [string, (message: unknown) => void] => [
        `nestjs:resilience:${type}`,
        (message) => {
          const event = message as ResilienceEvent;
          if (event.type === type && DEPENDENCIES.has(event.policy)) {
            listener.circuitChanged(event.policy as Dependency, event.to);
          }
        },
      ],
    ),
  ];
  for (const [name, handler] of handlers) subscribe(name, handler);
  return () => {
    for (const [name, handler] of handlers) unsubscribe(name, handler);
  };
}
