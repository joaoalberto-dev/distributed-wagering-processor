import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  ReconciliationReader,
  TransactionRepository,
  WalletRepository,
} from './repositories.js';

/** The repositories of one SQL transaction. They are valid only inside `UnitOfWork.run`. */
export interface TxContext {
  readonly wallets: WalletRepository;
  readonly transactions: TransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
  readonly reconciliation: ReconciliationReader;
}

export type UnitOfWorkOptions = {
  /** Retry Contention-class errors in process; true only for HTTP. */
  readonly retryContention: boolean;
  /**
   * `write` (the default) runs under `READ COMMITTED` with the per-transaction
   * lock and transaction timeouts. `read-only-snapshot` runs one
   * `REPEATABLE READ READ ONLY` transaction with the reconciliation timeouts.
   */
  readonly mode?: 'write' | 'read-only-snapshot';
};

/**
 * Runs `fn` in one SQL transaction and writes its changes with one flush at
 * the end. If `fn` throws, nothing is written. Database errors leave as the
 * application errors of `errors.ts` (Contention, Outage, identity races) or
 * unchanged when unexpected.
 */
export interface UnitOfWork {
  run<T>(
    fn: (tx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
