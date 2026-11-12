import type { CircuitState } from '@nestjs/resilience';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type {
  DlqReason,
  RetryClass,
} from '../../application/messaging/process-wager-message.js';
import type { Channel, Telemetry } from '../../application/ports/telemetry.js';
import type { PersistenceObserver } from '../persistence/mikro-orm-unit-of-work.js';
import type { DatabaseTimeout } from '../persistence/pg-error-classifier.js';
import type {
  BulkheadGroup,
  Dependency,
  PolicyListener,
} from '../resilience/policies.js';

/** Latency buckets in seconds (tuning table). */
export const LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

const CIRCUIT_VALUE: Readonly<Record<CircuitState, number>> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/**
 * One Prometheus registry per process. It implements the application's
 * `Telemetry` port and listens to the resilience policies and the
 * persistence adapters; `DatabaseGauges` adds its gauges to the registry.
 */
export class Metrics implements Telemetry, PolicyListener, PersistenceObserver {
  readonly registry = new Registry();

  readonly #transactions = this.#counter(
    'wager_transactions_total',
    'Transactions decided, counted after commit',
    ['kind', 'status', 'channel'],
  );
  readonly #duration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'From use-case entry to commit or replay',
    labelNames: ['channel'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly #lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time spent acquiring a waiting wallet row lock',
    labelNames: ['channel'],
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly #lockTimeouts = this.#counter(
    'wallet_lock_timeouts_total',
    'Transactions ended by lock_timeout (55P03)',
  );
  readonly #statementTimeouts = this.#counter(
    'statement_timeouts_total',
    'Statements ended by statement_timeout (57014)',
  );
  readonly #replays = this.#counter(
    'idempotent_replays_total',
    'Requests answered with a stored result',
    ['channel'],
  );
  readonly #conflicts = this.#counter(
    'idempotency_conflicts_total',
    'Requests refused for reusing an identity with another operation',
    ['code'],
  );
  readonly #inboxDuplicates = this.#counter(
    'inbox_duplicates_total',
    'SQS deliveries of a message already processed',
  );
  readonly #messageIdConflicts = this.#counter(
    'message_id_conflicts_total',
    'SQS messageIds reused for another operation',
  );
  readonly #uniqueRetries = this.#counter(
    'unique_violation_retries_total',
    'Identity races resolved by a re-read',
  );
  readonly #referenceAttempts = this.#counter(
    'reference_attempts_total',
    'Pending-reference worker attempts by outcome',
    ['outcome'],
  );
  readonly #referenceFailed = this.#counter(
    'reference_failed_total',
    'Pending references that ended FAILED',
  );
  readonly #divergences = this.#counter(
    'reconciliation_divergences_total',
    'Reconciliation issues found, by issue',
    ['issue'],
  );
  readonly #publishAttempts = this.#counter(
    'outbox_publish_attempts_total',
    'Outbox send attempts by result',
    ['result'],
  );
  readonly #senderFaults = this.#counter(
    'outbox_sender_faults_total',
    'Outbox entries refused by SQS as malformed',
  );
  readonly #sqsRetries = this.#counter(
    'sqs_retries_total',
    'SQS messages backed off for another receive, by error class',
    ['error_class'],
  );
  readonly #dlqMoves = this.#counter(
    'sqs_dlq_moves_total',
    'SQS messages moved to the DLQ by the application, by reason',
    ['reason'],
  );
  readonly #bulkheadRejections = this.#counter(
    'bulkhead_rejections_total',
    'Calls refused by a full bulkhead, by route group',
    ['group'],
  );
  readonly #circuitState = new Gauge({
    name: 'circuit_state',
    help: 'Circuit state per dependency: 0 closed, 1 half-open, 2 open',
    labelNames: ['dependency'],
    registers: [this.registry],
  });

  constructor() {
    this.#circuitState.set({ dependency: 'postgres' }, 0);
    this.#circuitState.set({ dependency: 'sqs' }, 0);
  }

  /** The exposition text for `GET /metrics`. */
  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  transactionDecided(kind: string, status: string, channel: Channel): void {
    this.#transactions.inc({ kind, status, channel });
  }
  processingDuration(channel: Channel, seconds: number): void {
    this.#duration.observe({ channel }, seconds);
  }
  idempotentReplay(channel: Channel): void {
    this.#replays.inc({ channel });
  }
  idempotencyConflict(
    code: 'IDEMPOTENCY_KEY_CONFLICT' | 'EXTERNAL_TRANSACTION_ID_CONFLICT',
  ): void {
    this.#conflicts.inc({ code });
  }
  inboxDuplicate(): void {
    this.#inboxDuplicates.inc();
  }
  messageIdConflict(): void {
    this.#messageIdConflicts.inc();
  }
  uniqueViolationRetry(): void {
    this.#uniqueRetries.inc();
  }
  referenceAttempt(
    outcome: 'wait' | 'processed' | 'rejected' | 'failed' | 'skipped',
  ): void {
    this.#referenceAttempts.inc({ outcome });
  }
  referenceFailed(): void {
    this.#referenceFailed.inc();
  }
  reconciliationDivergence(issue: string): void {
    this.#divergences.inc({ issue });
  }
  outboxPublishAttempt(result: 'ok' | 'retry' | 'sender-fault'): void {
    this.#publishAttempts.inc({ result });
    if (result === 'sender-fault') this.#senderFaults.inc();
  }

  /** Raised by the SQS consumer, not through the application's port. */
  sqsRetry(errorClass: RetryClass): void {
    this.#sqsRetries.inc({ error_class: errorClass });
  }
  sqsDlqMove(reason: DlqReason): void {
    this.#dlqMoves.inc({ reason });
  }

  /** Raised by the persistence adapters. */
  walletLockWait(channel: Channel | undefined, seconds: number): void {
    this.#lockWait.observe({ channel: channel ?? 'none' }, seconds);
  }
  databaseTimeout(kind: DatabaseTimeout): void {
    if (kind === 'lock') this.#lockTimeouts.inc();
    else this.#statementTimeouts.inc();
  }

  bulkheadRejected(group: BulkheadGroup): void {
    this.#bulkheadRejections.inc({ group });
  }
  circuitChanged(dependency: Dependency, state: CircuitState): void {
    this.#circuitState.set({ dependency }, CIRCUIT_VALUE[state]);
  }

  #counter<L extends string>(
    name: string,
    help: string,
    labelNames: readonly L[] = [],
  ): Counter<L> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }
}
