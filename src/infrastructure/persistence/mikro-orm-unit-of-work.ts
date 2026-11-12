import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Channel } from '../../application/ports/telemetry.js';
import type {
  TxContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../../application/ports/unit-of-work.js';
import {
  classifyPgError,
  type DatabaseTimeout,
  timeoutOf,
} from './pg-error-classifier.js';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox-repository.js';
import { MikroOrmLedgerRepository } from './repositories/mikro-orm-ledger-repository.js';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox-repository.js';
import { MikroOrmTransactionRepository } from './repositories/mikro-orm-transaction-repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet-repository.js';
import { SqlReconciliationReader } from './repositories/sql-reconciliation-reader.js';

/** Per-transaction limits (tuning table). */
export type UnitOfWorkTimeouts = {
  readonly lockTimeoutMs: number;
  readonly transactionTimeoutMs: number;
  /** Reconciliation (`read-only-snapshot`) statement limit. */
  readonly snapshotStatementTimeoutMs: number;
  readonly snapshotTransactionTimeoutMs: number;
};

export const DEFAULT_TIMEOUTS: Omit<UnitOfWorkTimeouts, 'lockTimeoutMs'> = {
  transactionTimeoutMs: 10_000,
  snapshotStatementTimeoutMs: 30_000,
  snapshotTransactionTimeoutMs: 35_000,
};

/** Runs a call under a resilience policy: a retry, a circuit, or nothing. */
export type CallGuard = <T>(call: () => Promise<T>) => Promise<T>;

/** Retries the whole unit of work on Contention. */
export type ContentionRetry = CallGuard;

export const NO_RETRY: ContentionRetry = (attempt) => attempt();

/** No policy around the call. */
export const UNGUARDED: CallGuard = (call) => call();

/** What the persistence adapters measure for the metrics (metric table). */
export type PersistenceObserver = {
  /** Seconds spent in a waiting wallet lock (`SELECT … FOR UPDATE`). */
  walletLockWait(channel: Channel | undefined, seconds: number): void;
  /** A `lock_timeout` (`55P03`) or `statement_timeout` (`57014`). */
  databaseTimeout(kind: DatabaseTimeout): void;
};

export const NO_OBSERVER: PersistenceObserver = {
  walletLockWait: () => undefined,
  databaseTimeout: () => undefined,
};

/** Counts a timeout, if `error` is one, and returns the classified error. */
export function observeAndClassify(
  error: unknown,
  observer: PersistenceObserver,
): unknown {
  const timeout = timeoutOf(error);
  if (timeout !== null) observer.databaseTimeout(timeout);
  return classifyPgError(error);
}

/** The repositories of one transaction, all on the same entity manager. */
export class MikroOrmTxContext implements TxContext {
  readonly wallets: MikroOrmWalletRepository;
  readonly transactions: MikroOrmTransactionRepository;
  readonly ledger: MikroOrmLedgerRepository;
  readonly inbox: MikroOrmInboxRepository;
  readonly outbox: MikroOrmOutboxRepository;
  readonly reconciliation: SqlReconciliationReader;

  /** `em` is exposed for infrastructure tests only; application code uses the repositories. */
  constructor(
    readonly em: EntityManager,
    onLockWait: (seconds: number) => void = () => undefined,
  ) {
    this.wallets = new MikroOrmWalletRepository(em, onLockWait);
    this.transactions = new MikroOrmTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
    this.reconciliation = new SqlReconciliationReader(em);
  }
}

/**
 * One SQL transaction per `run`, on a fresh entity-manager fork: the
 * callback's changes are written by the single flush at the end (the ORM
 * runs with `FlushMode.COMMIT`), and raw SQL runs at once on the same
 * connection. Errors leave classified (§10).
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly timeouts: UnitOfWorkTimeouts,
    private readonly retryContention: ContentionRetry = NO_RETRY,
    /** The `postgres` circuit, around each attempt: an open circuit fails fast. */
    private readonly circuit: CallGuard = UNGUARDED,
    private readonly observer: PersistenceObserver = NO_OBSERVER,
  ) {}

  run<T>(
    fn: (tx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    const attempt = () =>
      this.circuit(() =>
        this.runOnce(fn, options.mode ?? 'write', options.channel),
      );
    return options.retryContention ? this.retryContention(attempt) : attempt();
  }

  private async runOnce<T>(
    fn: (tx: TxContext) => Promise<T>,
    mode: 'write' | 'read-only-snapshot',
    channel: Channel | undefined,
  ): Promise<T> {
    const snapshot = mode === 'read-only-snapshot';
    const onLockWait = (seconds: number) =>
      this.observer.walletLockWait(channel, seconds);
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await this.applyTimeouts(em, snapshot);
          return fn(new MikroOrmTxContext(em, onLockWait));
        },
        snapshot
          ? { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true }
          : { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw observeAndClassify(error, this.observer);
    }
  }

  /** `set_config(…, true)` is transaction-local: the pooled connection keeps its defaults. */
  private async applyTimeouts(
    em: EntityManager,
    snapshot: boolean,
  ): Promise<void> {
    const t = this.timeouts;
    const [first, second] = snapshot
      ? [
          ['statement_timeout', t.snapshotStatementTimeoutMs],
          ['transaction_timeout', t.snapshotTransactionTimeoutMs],
        ]
      : [
          ['lock_timeout', t.lockTimeoutMs],
          ['transaction_timeout', t.transactionTimeoutMs],
        ];
    await em.execute('SELECT set_config(?, ?, true), set_config(?, ?, true)', [
      first[0],
      `${first[1]}ms`,
      second[0],
      `${second[1]}ms`,
    ]);
  }
}
