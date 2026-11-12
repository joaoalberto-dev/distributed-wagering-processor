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
import { classifySqsError } from '../messaging/sqs-error-classifier.js';
import type { CallGuard } from '../persistence/mikro-orm-unit-of-work.js';

/** The route groups with their own bulkhead (connection budget, §10). */
export type BulkheadGroup = 'http' | 'reconciliation' | 'readiness';

export type Dependency = 'postgres' | 'sqs';

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
  /**
   * Runs an SQS call through the `sqs` circuit. Its errors are classified
   * first, so an unreachable SQS or a 5xx is an outage the circuit records.
   */
  readonly sqs: CallGuard;
};

/** Five consecutive outages open a circuit for 5 s; one half-open probe (tuning table). */
function circuit(name: Dependency): CircuitBreakerPolicy {
  return new CircuitBreakerPolicy({
    name,
    // Five consecutive outages: every recorded call in a window of five failed.
    failureRateThreshold: 100,
    minimumCalls: 5,
    slidingWindow: { type: 'count', size: 5 },
    openDuration: '5s',
    halfOpenMaxCalls: 1,
    // Contention on a hot wallet must never open it.
    recordIf: (error) => error instanceof OutageError,
  });
}

/** A call through `policy`, its errors classified inside, and an open circuit as an outage. */
function guard(
  dependency: Dependency,
  policy: CircuitBreakerPolicy,
  classify: (error: unknown) => unknown = (error) => error,
): CallGuard {
  return async (call) => {
    try {
      return await policy.execute(async () => {
        try {
          return await call();
        } catch (error) {
          throw classify(error);
        }
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new OutageError(dependency, 'circuit open', { cause: error });
      }
      throw error;
    }
  };
}

export function createPolicies(config: Pick<AppConfig, 'http'>): Policies {
  const retry = new RetryPolicy({
    name: 'http-contention',
    attempts: 3,
    backoff: { delay: 50, jitter: 'full' },
    retryIf: (error) => error instanceof ContentionError,
  });
  const postgres = circuit('postgres');
  const sqs = circuit('sqs');
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
    circuits: { postgres, sqs },
    postgres: guard('postgres', postgres),
    sqs: guard('sqs', sqs, classifySqsError),
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
const DEPENDENCIES: ReadonlySet<string> = new Set<Dependency>([
  'postgres',
  'sqs',
]);

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
