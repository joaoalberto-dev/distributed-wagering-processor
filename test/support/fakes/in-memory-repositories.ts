import {
  IdentityRaceError,
  WalletAlreadyExists,
} from '../../../src/application/errors.js';
import type {
  InboxRepository,
  LedgerAggregate,
  LedgerRepository,
  OutboxRepository,
  PendingSchedule,
  ReconciliationReader,
  TransactionRepository,
  WalletRepository,
} from '../../../src/application/ports/repositories.js';
import type { Clock } from '../../../src/application/ports/clock.js';
import type { TxContext } from '../../../src/application/ports/unit-of-work.js';
import {
  WalletLedgerEntry,
  type WalletLedgerEntryState,
} from '../../../src/domain/ledger/wallet-ledger-entry.js';
import {
  InboxMessage,
  type InboxMessageState,
} from '../../../src/domain/messaging/inbox-message.js';
import {
  OutboxMessage,
  type OutboxMessageState,
} from '../../../src/domain/messaging/outbox-message.js';
import {
  WagerTransaction,
  type WagerTransactionState,
} from '../../../src/domain/transaction/wager-transaction.js';
import { Wallet, type WalletState } from '../../../src/domain/wallet/wallet.js';

export type PendingTimes = {
  nextAttemptAt: Date;
  readonly expiresAt: Date;
};

/** The committed rows, as plain states, so loads return fresh aggregates. */
export class InMemoryStore {
  wallets = new Map<string, WalletState>();
  transactions = new Map<string, WagerTransactionState>();
  pending = new Map<string, PendingTimes>();
  ledger = new Map<string, WalletLedgerEntryState>();
  inbox = new Map<string, InboxMessageState>();
  outbox = new Map<string, OutboxMessageState>();

  clone(): InMemoryStore {
    const copy = new InMemoryStore();
    copy.wallets = new Map(this.wallets);
    copy.transactions = new Map(this.transactions);
    copy.pending = new Map(
      [...this.pending].map(([id, times]) => [id, { ...times }]),
    );
    copy.ledger = new Map(this.ledger);
    copy.inbox = new Map(this.inbox);
    copy.outbox = new Map(this.outbox);
    return copy;
  }

  /** The unique constraints the fakes check at commit, like the deferred ones. */
  assertConstraints(): void {
    const seen = new Set<string>();
    for (const wallet of this.wallets.values()) {
      const key = `${wallet.playerId}:${wallet.currency}`;
      if (seen.has(key)) throw new WalletAlreadyExists();
      seen.add(key);
    }
    const keys = new Set<string>();
    const externalIds = new Set<string>();
    for (const t of this.transactions.values()) {
      if (t.providerId === null) continue;
      const key = `${t.providerId}:${t.idempotencyKey}`;
      if (keys.has(key)) throw new IdentityRaceError('idempotency_key');
      keys.add(key);
      const externalId = `${t.providerId}:${t.externalTransactionId}`;
      if (externalIds.has(externalId)) {
        throw new IdentityRaceError('external_transaction_id');
      }
      externalIds.add(externalId);
    }
  }
}

class Wallets implements WalletRepository {
  constructor(private readonly store: InMemoryStore) {}

  lock(id: string): Promise<Wallet | null> {
    return this.findById(id);
  }
  findById(id: string): Promise<Wallet | null> {
    const state = this.store.wallets.get(id);
    return Promise.resolve(
      state === undefined ? null : Wallet.rehydrate(state),
    );
  }
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const state = [...this.store.wallets.values()].find(
      (w) => w.playerId === playerId && w.currency === currency,
    );
    return Promise.resolve(
      state === undefined ? null : Wallet.rehydrate(state),
    );
  }
  insert(wallet: Wallet): Promise<void> {
    this.store.wallets.set(wallet.id, wallet.toState());
    return Promise.resolve();
  }
  save(wallet: Wallet): Promise<void> {
    this.store.wallets.set(wallet.id, wallet.toState());
    return Promise.resolve();
  }
}

class Transactions implements TransactionRepository {
  constructor(
    private readonly store: InMemoryStore,
    private readonly clock: Clock,
  ) {}

  #find(
    predicate: (t: WagerTransactionState) => boolean,
  ): Promise<WagerTransaction | null> {
    const state = [...this.store.transactions.values()].find(predicate);
    return Promise.resolve(
      state === undefined ? null : WagerTransaction.rehydrate(state),
    );
  }
  findByKey(providerId: string, idempotencyKey: string) {
    return this.#find(
      (t) => t.providerId === providerId && t.idempotencyKey === idempotencyKey,
    );
  }
  findByExternalId(providerId: string, externalId: string) {
    return this.#find(
      (t) =>
        t.providerId === providerId && t.externalTransactionId === externalId,
    );
  }
  findById(id: string) {
    return this.#find((t) => t.id === id);
  }
  findSuccessfulReversal(referenceTransactionId: string) {
    return this.#find(
      (t) =>
        t.referenceTransactionId === referenceTransactionId &&
        t.status === 'PROCESSED' &&
        (t.kind === 'REFUND' || t.kind === 'ROLLBACK'),
    );
  }
  insert(
    transaction: WagerTransaction,
    pending?: PendingSchedule,
  ): Promise<{ referenceExpiresAt?: Date }> {
    this.store.transactions.set(transaction.id, transaction.toState());
    if (pending === undefined) return Promise.resolve({});
    const now = this.clock.now().getTime();
    const times = {
      nextAttemptAt: new Date(now + pending.backoffMs),
      expiresAt: new Date(now + pending.ttlMs),
    };
    this.store.pending.set(transaction.id, times);
    return Promise.resolve({ referenceExpiresAt: times.expiresAt });
  }
  save(transaction: WagerTransaction): Promise<void> {
    this.store.transactions.set(transaction.id, transaction.toState());
    return Promise.resolve();
  }
  #due(id: string): PendingTimes | undefined {
    const times = this.store.pending.get(id);
    const state = this.store.transactions.get(id);
    return state?.status === 'PENDING_REFERENCE' &&
      times !== undefined &&
      times.nextAttemptAt <= this.clock.now()
      ? times
      : undefined;
  }
  #later(times: PendingTimes, delayMs: number): Date {
    const at = this.clock.now().getTime() + delayMs;
    return new Date(Math.min(at, times.expiresAt.getTime()));
  }
  reschedule(id: string, backoffMs: number): Promise<boolean> {
    const times = this.#due(id);
    const state = this.store.transactions.get(id);
    if (times === undefined || state === undefined) {
      return Promise.resolve(false);
    }
    this.store.transactions.set(id, { ...state, attempts: state.attempts + 1 });
    times.nextAttemptAt = this.#later(times, backoffMs);
    return Promise.resolve(true);
  }
  /** Calls run one at a time, so a due row is always free to claim. */
  claim(id: string, _mode: 'wait' | 'skip-locked'): Promise<boolean> {
    return Promise.resolve(this.#due(id) !== undefined);
  }
  pushBack(id: string, delayMs: number): Promise<boolean> {
    const times = this.#due(id);
    if (times === undefined) return Promise.resolve(false);
    times.nextAttemptAt = this.#later(times, delayMs);
    return Promise.resolve(true);
  }
  wakeDependents(
    walletId: string,
    providerId: string,
    externalId: string,
  ): Promise<number> {
    let woken = 0;
    for (const [id, state] of this.store.transactions) {
      const times = this.store.pending.get(id);
      if (
        times !== undefined &&
        state.status === 'PENDING_REFERENCE' &&
        state.walletId === walletId &&
        state.providerId === providerId &&
        state.referenceExternalTransactionId === externalId
      ) {
        times.nextAttemptAt = this.clock.now();
        woken += 1;
      }
    }
    return Promise.resolve(woken);
  }
  selectDue(limit: number): Promise<string[]> {
    const due = [...this.store.pending.keys()]
      .filter((id) => this.#due(id) !== undefined)
      .sort(
        (a, b) =>
          (this.store.pending.get(a)?.nextAttemptAt.getTime() ?? 0) -
          (this.store.pending.get(b)?.nextAttemptAt.getTime() ?? 0),
      );
    return Promise.resolve(due.slice(0, limit));
  }
  recheck(id: string): Promise<{ due: boolean; ttlReached: boolean } | null> {
    const times = this.store.pending.get(id);
    if (times === undefined) return Promise.resolve(null);
    return Promise.resolve({
      due: this.#due(id) !== undefined,
      ttlReached: times.expiresAt <= this.clock.now(),
    });
  }
}

class Ledger implements LedgerRepository {
  constructor(private readonly store: InMemoryStore) {}

  append(entry: WalletLedgerEntry): Promise<void> {
    this.store.ledger.set(entry.id, entry.toState());
    return Promise.resolve();
  }
  findByTransactionId(transactionId: string) {
    const state = [...this.store.ledger.values()].find(
      (e) => e.transactionId === transactionId,
    );
    return Promise.resolve(
      state === undefined ? null : WalletLedgerEntry.rehydrate(state),
    );
  }
}

class Inbox implements InboxRepository {
  constructor(private readonly store: InMemoryStore) {}

  find(consumerName: string, messageId: string) {
    const state = this.store.inbox.get(`${consumerName}:${messageId}`);
    return Promise.resolve(
      state === undefined ? null : InboxMessage.rehydrate(state),
    );
  }
  insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const state = message.toState();
    const key = `${state.consumerName}:${state.messageId}`;
    if (this.store.inbox.has(key)) return Promise.resolve(false);
    this.store.inbox.set(key, state);
    return Promise.resolve(true);
  }
}

class Outbox implements OutboxRepository {
  constructor(
    private readonly store: InMemoryStore,
    private readonly clock: Clock,
  ) {}

  enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      this.store.outbox.set(message.id, message.toState());
    }
    return Promise.resolve();
  }
  claimDue(limit: number): Promise<OutboxMessage[]> {
    const due = [...this.store.outbox.values()]
      .filter((m) => m.publishedAt === null)
      .slice(0, limit)
      .map((m) => OutboxMessage.rehydrate(m));
    return Promise.resolve(due);
  }
  markPublished(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const state = this.store.outbox.get(id);
      if (state !== undefined) {
        this.store.outbox.set(id, { ...state, publishedAt: this.clock.now() });
      }
    }
    return Promise.resolve();
  }
  scheduleRetry(id: string, _backoffMs: number, error: string): Promise<void> {
    const state = this.store.outbox.get(id);
    if (state !== undefined) {
      this.store.outbox.set(id, {
        ...state,
        attempts: state.attempts + 1,
        lastError: error,
      });
    }
    return Promise.resolve();
  }
}

class Reconciliation implements ReconciliationReader {
  constructor(private readonly store: InMemoryStore) {}

  aggregate(walletId: string): Promise<LedgerAggregate | null> {
    const wallet = this.store.wallets.get(walletId);
    if (wallet === undefined) return Promise.resolve(null);
    const entries = [...this.store.ledger.values()]
      .filter((e) => e.walletId === walletId)
      .sort((a, b) => a.walletVersion - b.walletVersion);
    let sum = 0n;
    let chainBreaks = 0;
    entries.forEach((entry, i) => {
      sum +=
        entry.direction === 'CREDIT' ? entry.amount.minor : -entry.amount.minor;
      const previous = entries[i - 1];
      if (
        previous !== undefined &&
        !entry.balanceBefore.equals(previous.balanceAfter)
      ) {
        chainBreaks += 1;
      }
    });
    const versions = entries.map((e) => e.walletVersion);
    const hasOpening = entries.some(
      (e) => this.store.transactions.get(e.transactionId)?.kind === 'OPENING',
    );
    const missingVersions: number[] = [];
    const present = new Set(versions);
    for (let v = hasOpening ? 1 : 2; v <= Math.max(0, ...versions); v++) {
      if (!present.has(v)) missingVersions.push(v);
    }
    return Promise.resolve({
      storedBalance: wallet.balance.toProps().amount,
      currency: wallet.currency,
      storedVersion: wallet.version,
      ledgerSumMinor: sum,
      entryCount: entries.length,
      minVersion: versions.length === 0 ? null : Math.min(...versions),
      maxVersion: versions.length === 0 ? null : Math.max(...versions),
      hasOpening,
      missingVersions,
      firstBalanceBefore: entries[0]?.balanceBefore.toProps().amount ?? null,
      chainBreaks,
    });
  }
}

/** The repositories of one fake transaction, all over the same working copy. */
export function inMemoryTxContext(
  store: InMemoryStore,
  clock: Clock,
): TxContext {
  return {
    wallets: new Wallets(store),
    transactions: new Transactions(store, clock),
    ledger: new Ledger(store),
    inbox: new Inbox(store),
    outbox: new Outbox(store, clock),
    reconciliation: new Reconciliation(store),
  };
}
