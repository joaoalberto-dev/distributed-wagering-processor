import type { RejectionCode } from '../failure-code.js';
import {
  LedgerDirection,
  oppositeDirection,
} from '../ledger/ledger-direction.js';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { InvariantViolationError } from '../shared/domain-error.js';
import {
  ALLOWED_REFERENCES,
  isReversal,
  KIND_EFFECT,
} from '../transaction/transaction-kind.js';
import type {
  ReferenceField,
  ResultDetails,
  WagerTransaction,
} from '../transaction/wager-transaction.js';
import type { BalanceEffect, Wallet } from '../wallet/wallet.js';

export type SettleInput = {
  /** `PENDING` (submission) or `PENDING_REFERENCE` (worker). */
  readonly transaction: WagerTransaction;
  /** The locked wallet of the transaction (D1 is the caller's lookup). */
  readonly wallet: Wallet;
  /** Resolved by `(providerId, referenceExternalTransactionId)`; null if absent. */
  readonly reference: WagerTransaction | null;
  /** The reference's ledger entry, needed for a `ROLLBACK`. */
  readonly referenceEntry: WalletLedgerEntry | null;
  /** A `PROCESSED` `REFUND` or `ROLLBACK` of the reference, if any. */
  readonly existingReversal: WagerTransaction | null;
  /** Computed by the caller from the database clock. */
  readonly ttlReached: boolean;
};

export type Decision =
  | {
      readonly kind: 'process';
      readonly effect: BalanceEffect | null;
      readonly details?: ResultDetails;
    }
  | {
      readonly kind: 'reject';
      readonly failureCode: RejectionCode;
      readonly details?: ResultDetails;
    }
  | { readonly kind: 'wait' };

const WAIT: Decision = { kind: 'wait' };

function reject(failureCode: RejectionCode, details?: ResultDetails): Decision {
  return details === undefined
    ? { kind: 'reject', failureCode }
    : { kind: 'reject', failureCode, details };
}

/**
 * The one decision function, called under the wallet lock by submission and
 * by the pending-reference worker. It runs the domain checks D2–D11 in order;
 * the first failing check decides. It mutates nothing: the persistence step
 * applies the decision.
 */
export function settle(input: SettleInput): Decision {
  const { transaction, wallet } = input;
  assertCallable(input);

  // D2, D3.
  if (!wallet.belongsTo(transaction.playerId)) {
    return reject('WALLET_PLAYER_MISMATCH');
  }
  if (transaction.money.currency !== wallet.currency) {
    return reject('CURRENCY_MISMATCH');
  }

  let details: ResultDetails | undefined;
  if (transaction.referenceExternalTransactionId !== null) {
    const outcome = checkReference(input);
    if (outcome.kind !== 'continue') return outcome.decision;
    details = outcome.details;
  }

  // D10, D11.
  const effect = effectOf(input);
  if (effect !== null) {
    switch (wallet.check(effect)) {
      case 'BELOW_ZERO':
        return reject(
          transaction.kind === 'ROLLBACK'
            ? 'REVERSAL_INSUFFICIENT_FUNDS'
            : 'INSUFFICIENT_FUNDS',
        );
      case 'ABOVE_CEILING':
        return reject('BALANCE_LIMIT_EXCEEDED');
      case 'OK':
        break;
    }
  }

  return details === undefined
    ? { kind: 'process', effect }
    : { kind: 'process', effect, details };
}

type ReferenceOutcome =
  | { readonly kind: 'stop'; readonly decision: Decision }
  | { readonly kind: 'continue'; readonly details?: ResultDetails };

/** D4–D9. */
function checkReference(input: SettleInput): ReferenceOutcome {
  const { transaction, reference, existingReversal, ttlReached } = input;
  const stop = (decision: Decision): ReferenceOutcome => ({
    kind: 'stop',
    decision,
  });

  // D4.
  if (reference === null) {
    return stop(ttlReached ? reject('REFERENCE_NOT_FOUND') : WAIT);
  }
  if (
    reference.providerId !== transaction.providerId ||
    reference.externalTransactionId !==
      transaction.referenceExternalTransactionId
  ) {
    throw new InvariantViolationError(
      'the reference must be resolved by (providerId, referenceExternalTransactionId)',
    );
  }

  // D5.
  const field = firstDifference(transaction, reference);
  if (field !== null) return stop(reject('REFERENCE_MISMATCH', { field }));

  // D6.
  if (!ALLOWED_REFERENCES[transaction.kind].includes(reference.kind)) {
    return stop(reject('REFERENCE_INVALID'));
  }

  // D7.
  if (
    isReversal(transaction.kind) &&
    !transaction.money.equals(reference.money)
  ) {
    return stop(reject('REFERENCE_MISMATCH', { field: 'amount' }));
  }

  // D8.
  switch (reference.status) {
    case 'PENDING':
    case 'PENDING_REFERENCE':
      return stop(ttlReached ? reject('REFERENCE_NOT_READY') : WAIT);
    case 'REJECTED':
    case 'FAILED':
      return stop(reject('REFERENCE_NOT_PROCESSED'));
    case 'PROCESSED':
      break;
  }

  // D9.
  if (existingReversal === null) return { kind: 'continue' };
  if (
    existingReversal.referenceTransactionId !== reference.id ||
    existingReversal.status !== 'PROCESSED' ||
    !isReversal(existingReversal.kind)
  ) {
    throw new InvariantViolationError(
      'the existing reversal must be a processed reversal of the reference',
    );
  }
  const reversedBy = { referenceReversedBy: existingReversal.id };
  if (isReversal(transaction.kind)) {
    return stop(reject('REFERENCE_ALREADY_REVERSED', reversedBy));
  }
  // A WIN or LOSS against a reversed BET is processed and flagged.
  return { kind: 'continue', details: reversedBy };
}

/** D5: the fields compared in order; the first that differs is named. */
function firstDifference(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): ReferenceField | null {
  if (reference.playerId !== transaction.playerId) return 'playerId';
  if (reference.walletId !== transaction.walletId) return 'walletId';
  if (reference.money.currency !== transaction.money.currency) {
    return 'currency';
  }
  if (reference.roundId !== transaction.roundId) return 'roundId';
  return null;
}

function effectOf(input: SettleInput): BalanceEffect | null {
  const { transaction } = input;
  switch (KIND_EFFECT[transaction.kind]) {
    case 'NONE':
      return null;
    case 'DEBIT':
      return { direction: LedgerDirection.Debit, amount: transaction.money };
    case 'CREDIT':
      return { direction: LedgerDirection.Credit, amount: transaction.money };
    case 'INVERSE': {
      const entry = input.referenceEntry;
      if (entry === null || entry.transactionId !== input.reference?.id) {
        throw new InvariantViolationError(
          'a ROLLBACK needs the ledger entry of its processed reference',
        );
      }
      return {
        direction: oppositeDirection(entry.direction),
        amount: entry.amount,
      };
    }
  }
}

function assertCallable({ transaction, wallet }: SettleInput): void {
  if (transaction.isTerminal()) {
    throw new InvariantViolationError(
      `cannot settle a ${transaction.status} transaction`,
    );
  }
  if (wallet.id !== transaction.walletId) {
    throw new InvariantViolationError(
      'settle needs the wallet of the transaction',
    );
  }
}
