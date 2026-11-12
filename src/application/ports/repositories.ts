import type { LedgerFigures } from '../../domain/reconciliation/reconciliation-report.js';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import type { InboxMessage } from '../../domain/messaging/inbox-message.js';
import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';

/**
 * Repositories of one SQL transaction, reached through `TxContext`. Loads
 * rebuild aggregates with `rehydrate`; `insert` and `save` are written by the
 * unit of work's single flush. Times derived from delays use the database
 * clock, so instances with skewed clocks agree on what is due.
 */
export interface WalletRepository {
  /** `SELECT … FOR UPDATE [SKIP LOCKED]`, refreshed from the row. Null when absent or, with `skip-locked`, busy. */
  lock(id: string, mode: 'wait' | 'skip-locked'): Promise<Wallet | null>;
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
}

export type PendingSchedule = {
  /** Delay until the first worker attempt. */
  readonly backoffMs: number;
  /** Time to live from now: `reference_expires_at`. */
  readonly ttlMs: number;
};

export interface TransactionRepository {
  findByKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null>;
  findById(id: string): Promise<WagerTransaction | null>;
  /** The `PROCESSED` `REFUND` or `ROLLBACK` of this transaction, if any. */
  findSuccessfulReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /**
   * Inserts the transaction. A `PENDING_REFERENCE` insert passes `pending`:
   * its next attempt and expiry are computed from the database clock, and the
   * expiry is returned for the pending-reference event.
   */
  insert(
    transaction: WagerTransaction,
    pending?: PendingSchedule,
  ): Promise<{ referenceExpiresAt?: Date }>;
  /** Writes a status change; the update is conditioned on the status it was loaded with. */
  save(transaction: WagerTransaction): Promise<void>;
  /**
   * Counts a worker attempt that still waits: `attempts + 1`, next attempt at
   * `min(now + backoff, expiry)`. Only if the row is still pending and due;
   * false when another worker already moved it.
   */
  reschedule(id: string, backoffMs: number): Promise<boolean>;
  /**
   * Locks a pending, due row for this worker's attempt. `skip-locked` gives
   * up at once when another worker holds it; `wait` waits for it. False when
   * the row is held elsewhere or no longer due.
   */
  claim(id: string, mode: 'wait' | 'skip-locked'): Promise<boolean>;
  /** Pushes a due row back by `delayMs` without counting an attempt; the caller has claimed it, not the wallet. */
  pushBack(id: string, delayMs: number): Promise<boolean>;
  /** Makes the pending dependents of `(providerId, externalId)` in this wallet due now; returns how many. */
  wakeDependents(
    walletId: string,
    providerId: string,
    externalId: string,
  ): Promise<number>;
  /** Up to `limit` due pending IDs, by due time, from a random offset into the first `maxOffset` due rows. */
  selectDue(limit: number, maxOffset: number): Promise<string[]>;
  /** Re-reads a row with the database clock: whether it is still pending and due, and whether its TTL is reached. */
  recheck(id: string): Promise<{ due: boolean; ttlReached: boolean } | null>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | null>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  /**
   * `INSERT … ON CONFLICT DO NOTHING`, immediately. False when the row already
   * exists; a concurrent insert of the same key waits for the other to commit.
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  /** Up to `limit` due, unpublished messages, locked with `FOR UPDATE SKIP LOCKED`. */
  claimDue(limit: number): Promise<OutboxMessage[]>;
  markPublished(ids: readonly string[]): Promise<void>;
  scheduleRetry(id: string, backoffMs: number, error: string): Promise<void>;
}

/** One wallet's ledger aggregates: exactly what the report needs (§14). */
export type LedgerAggregate = LedgerFigures;

export interface ReconciliationReader {
  aggregate(walletId: string): Promise<LedgerAggregate | null>;
}
