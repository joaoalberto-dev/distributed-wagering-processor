import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Gauge, type Registry } from 'prom-client';
import type { SqsQueues } from '../messaging/sqs-queues.js';
import { READINESS_CHECK_TIMEOUT_MS, within } from './indicators.js';

/** The database counts behind the outbox and pending-reference gauges. */
export type DatabaseBacklog = {
  readonly outboxPending: number;
  readonly outboxLagSeconds: number;
  readonly pendingReferences: number;
};

export type PoolUsage = { readonly inUse: number; readonly waiting: number };

/** Where the gauges come from; the adapters below, or fakes in unit specs. */
export type GaugeSources = {
  /** The outbox and pending-reference counts, in one round trip. */
  readonly backlog: () => Promise<DatabaseBacklog>;
  /** `ApproximateNumberOfMessages` of the input DLQ; `signal` aborts after a timeout. */
  readonly dlqDepth: (signal: AbortSignal) => Promise<number>;
  /** The process's own pool; no I/O. */
  readonly pool: () => Promise<PoolUsage>;
};

export type DatabaseGaugesOptions = {
  readonly sources: GaugeSources;
  readonly registry: Registry;
  /**
   * Whether this instance reads the database and the queue at all. Only
   * instances that run the publisher or the worker do (§18), so scraping
   * every instance does not multiply the load; dashboards take the `max`.
   * Other instances do not expose those gauges.
   */
  readonly readShared: boolean;
  readonly timeoutMs?: number;
};

/**
 * The gauges computed at scrape time (metric table). Each read has the
 * readiness timeout. A read that fails or times out sets its gauges to
 * `NaN`, which PromQL's `max` skips, rather than a stale or a zero value;
 * it never fails the scrape.
 */
export class DatabaseGauges {
  readonly #options: DatabaseGaugesOptions;
  readonly #poolInUse: Gauge;
  readonly #poolWaiting: Gauge;
  readonly #shared:
    | {
        readonly outboxPending: Gauge;
        readonly outboxLag: Gauge;
        readonly pendingReferences: Gauge;
        readonly dlqDepth: Gauge;
      }
    | undefined;

  constructor(options: DatabaseGaugesOptions) {
    this.#options = options;
    const gauge = (name: string, help: string) =>
      new Gauge({ name, help, registers: [options.registry] });
    this.#poolInUse = gauge(
      'db_pool_in_use',
      'Pooled PostgreSQL connections checked out',
    );
    this.#poolWaiting = gauge(
      'db_pool_waiting',
      'Callers waiting for a pooled PostgreSQL connection',
    );
    this.#shared = options.readShared
      ? {
          outboxPending: gauge(
            'outbox_pending',
            'Unpublished outbox events, read at scrape',
          ),
          outboxLag: gauge(
            'outbox_lag_seconds',
            'Age of the oldest unpublished outbox event, read at scrape',
          ),
          pendingReferences: gauge(
            'pending_references',
            'Transactions waiting for their reference, read at scrape',
          ),
          dlqDepth: gauge(
            'sqs_dlq_depth',
            'Messages in the input DLQ, read at scrape',
          ),
        }
      : undefined;
  }

  async refresh(): Promise<void> {
    const { sources } = this.#options;
    const timeoutMs = this.#options.timeoutMs ?? READINESS_CHECK_TIMEOUT_MS;
    const shared = this.#shared;
    const abort = new AbortController();
    const reads: Promise<void>[] = [];
    if (shared !== undefined) {
      reads.push(
        within(timeoutMs, sources.backlog()).then(
          (backlog) => {
            shared.outboxPending.set(backlog.outboxPending);
            shared.outboxLag.set(backlog.outboxLagSeconds);
            shared.pendingReferences.set(backlog.pendingReferences);
          },
          () => {
            shared.outboxPending.set(Number.NaN);
            shared.outboxLag.set(Number.NaN);
            shared.pendingReferences.set(Number.NaN);
          },
        ),
        within(timeoutMs, sources.dlqDepth(abort.signal)).then(
          (depth) => shared.dlqDepth.set(depth),
          () => shared.dlqDepth.set(Number.NaN),
        ),
      );
    }
    try {
      await Promise.all(reads);
    } finally {
      abort.abort();
    }
    // Last, so the scrape's own reads are back in the pool and not counted.
    try {
      const usage = await sources.pool();
      this.#poolInUse.set(usage.inUse);
      this.#poolWaiting.set(usage.waiting);
    } catch {
      // The pool counters are in memory; a failure only skips this scrape.
    }
  }
}

/** The counters `pg-pool` keeps. */
type PgPoolCounts = {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
};

type BacklogRow = {
  outbox_pending: string | number;
  outbox_lag_seconds: string | number;
  pending_references: string | number;
};

/** Both counts use the partial indexes of the publisher and the worker. */
const BACKLOG_SQL = `SELECT
  (SELECT count(*) FROM outbox WHERE published_at IS NULL) AS outbox_pending,
  (SELECT COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - min(occurred_at)), 0)
     FROM outbox WHERE published_at IS NULL) AS outbox_lag_seconds,
  (SELECT count(*) FROM wager_transactions
     WHERE status = 'PENDING_REFERENCE') AS pending_references`;

/**
 * The production sources. The reads bypass the circuits, like readiness:
 * a scrape never opens or closes one.
 */
export function gaugeSources(
  orm: MikroORM,
  sqs: SQSClient,
  queues: Pick<SqsQueues, 'url'>,
): GaugeSources {
  return {
    backlog: async () => {
      const [row] = await orm.em.fork().execute<BacklogRow[]>(BACKLOG_SQL);
      return {
        outboxPending: Number(row?.outbox_pending ?? 0),
        outboxLagSeconds: Math.max(0, Number(row?.outbox_lag_seconds ?? 0)),
        pendingReferences: Number(row?.pending_references ?? 0),
      };
    },
    dlqDepth: async (signal) => {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: await queues.url('deadLetter'),
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
        { abortSignal: signal },
      );
      return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
    },
    pool: async () => {
      // `pg` ships no types here, so the pool is read through its counters only.
      const pool = (await orm.em
        .getConnection()
        .getNativeClient()) as unknown as PgPoolCounts;
      return {
        inUse: pool.totalCount - pool.idleCount,
        waiting: pool.waitingCount,
      };
    },
  };
}
