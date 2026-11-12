import { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { Money } from '../../domain/money/money.js';
import type { Decision } from '../../domain/settlement/settle.js';
import { InvariantViolationError } from '../../domain/shared/domain-error.js';
import { WagerTransactionKind } from '../../domain/transaction/transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/transaction/transaction-status.js';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import type { BalanceEffect, Wallet } from '../../domain/wallet/wallet.js';
import type { TxContext } from '../ports/unit-of-work.js';
import { buildEvents, type EventTracing } from './build-events.js';

/** A decision of `settle`, or the worker's final attempt that threw at the TTL. */
export type Outcome = Decision | { readonly kind: 'fail' };

export type OutcomeContext = EventTracing & {
  /** `reference_expires_at` of a transaction that starts waiting, from now. */
  readonly referenceTtlMs: number;
  /** The resolved reference, recorded on a processed result (the schema's same-wallet foreign key). */
  readonly referenceTransactionId?: string;
};

/** The kinds whose terminal result can unblock a pending dependent (§11, Wake-up). */
const WAKING_KINDS: ReadonlySet<string> = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export type AppliedOutcome = {
  readonly transaction: WagerTransaction;
  readonly entry: WalletLedgerEntry | null;
};

/**
 * The one persistence step (§4): applies an outcome to the transaction and
 * the wallet and writes, through `tx`, the transaction, the wallet, the
 * ledger entry, the outbox events, and the wake-up of dependents.
 *
 * A `PENDING` transaction is new and is inserted; a `PENDING_REFERENCE` one
 * was loaded by the worker and is saved. The caller holds the wallet lock,
 * except for an `OPENING`, whose wallet is new and already inserted by the
 * caller at version 1 with its opening balance.
 */
export async function applyOutcome(
  tx: TxContext,
  transaction: WagerTransaction,
  wallet: Wallet,
  outcome: Outcome,
  ctx: OutcomeContext,
): Promise<AppliedOutcome> {
  const isNew = transaction.status === WagerTransactionStatus.Pending;
  const at = ctx.occurredAt;
  let entry: WalletLedgerEntry | null = null;
  let referenceExpiresAt: Date | null = null;

  switch (outcome.kind) {
    case 'process': {
      if (outcome.effect !== null) {
        entry = moveBalance(transaction, wallet, outcome.effect, ctx);
      }
      transaction.markProcessed({
        balance: wallet.balance,
        at,
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
        ...(ctx.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: ctx.referenceTransactionId }),
      });
      break;
    }
    case 'reject':
      transaction.markRejected({
        failureCode: outcome.failureCode,
        balance: wallet.balance,
        at,
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
      });
      break;
    case 'wait': {
      if (!isNew) {
        throw new InvariantViolationError(
          'a waiting worker attempt is rescheduled, not applied',
        );
      }
      const backoffMs = transaction.waitForReference();
      const times = await tx.transactions.insert(transaction, {
        backoffMs,
        ttlMs: ctx.referenceTtlMs,
      });
      referenceExpiresAt = times.referenceExpiresAt ?? null;
      break;
    }
    case 'fail':
      transaction.markFailed(at);
      break;
  }

  if (outcome.kind !== 'wait') {
    if (isNew) await tx.transactions.insert(transaction);
    else await tx.transactions.save(transaction);
  }
  if (entry !== null) {
    if (transaction.kind !== WagerTransactionKind.Opening) {
      await tx.wallets.save(wallet);
    }
    await tx.ledger.append(entry);
  }
  const events = buildEvents({ transaction, entry, referenceExpiresAt }, ctx);
  await tx.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));
  await wakeDependents(tx, transaction);
  return { transaction, entry };
}

/**
 * Moves the balance and builds its entry. An `OPENING` does not move the
 * balance: the new wallet already holds it at version 1, and its entry
 * records the move from zero.
 */
function moveBalance(
  transaction: WagerTransaction,
  wallet: Wallet,
  effect: BalanceEffect,
  ctx: OutcomeContext,
): WalletLedgerEntry {
  const applied =
    transaction.kind === WagerTransactionKind.Opening
      ? openingEffect(wallet, effect)
      : wallet.apply(effect, ctx.occurredAt);
  return WalletLedgerEntry.create({
    id: ctx.ids.uuidv7(),
    walletId: wallet.id,
    transactionId: transaction.id,
    direction: effect.direction,
    amount: effect.amount,
    balanceBefore: applied.balanceBefore,
    balanceAfter: applied.balanceAfter,
    walletVersion: applied.version,
    createdAt: ctx.occurredAt,
  });
}

function openingEffect(wallet: Wallet, effect: BalanceEffect) {
  if (
    wallet.version !== 1 ||
    effect.direction !== LedgerDirection.Credit ||
    !effect.amount.equals(wallet.balance)
  ) {
    throw new InvariantViolationError(
      'an OPENING credits the new wallet its opening balance at version 1',
    );
  }
  return {
    balanceBefore: Money.zero(wallet.currency),
    balanceAfter: wallet.balance,
    version: 1,
  };
}

async function wakeDependents(
  tx: TxContext,
  transaction: WagerTransaction,
): Promise<void> {
  const { providerId, externalTransactionId } = transaction;
  if (
    !transaction.isTerminal() ||
    !WAKING_KINDS.has(transaction.kind) ||
    providerId === null ||
    externalTransactionId === null
  ) {
    return;
  }
  await tx.transactions.wakeDependents(
    transaction.walletId,
    providerId,
    externalTransactionId,
  );
}
