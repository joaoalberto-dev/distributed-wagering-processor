import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { WagerTransactionKind } from '../../domain/transaction/transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/transaction/transaction-status.js';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import type { TxContext } from '../ports/unit-of-work.js';

/** What `settle` needs to know about a transaction's reference. */
export type ResolvedReference = {
  readonly reference: WagerTransaction | null;
  readonly referenceEntry: WalletLedgerEntry | null;
  readonly existingReversal: WagerTransaction | null;
};

const NO_REFERENCE: ResolvedReference = {
  reference: null,
  referenceEntry: null,
  existingReversal: null,
};

/**
 * D4 input, read under the wallet lock by submission and by the worker: the
 * reference by `(providerId, referenceExternalTransactionId)`, its ledger
 * entry for a `ROLLBACK`, and its successful reversal.
 */
export async function resolveReference(
  tx: TxContext,
  transaction: WagerTransaction,
): Promise<ResolvedReference> {
  const { providerId, referenceExternalTransactionId } = transaction;
  if (providerId === null || referenceExternalTransactionId === null) {
    return NO_REFERENCE;
  }
  const reference = await tx.transactions.findByExternalId(
    providerId,
    referenceExternalTransactionId,
  );
  if (reference === null) return NO_REFERENCE;
  const referenceEntry =
    transaction.kind === WagerTransactionKind.Rollback &&
    reference.status === WagerTransactionStatus.Processed
      ? await tx.ledger.findByTransactionId(reference.id)
      : null;
  const existingReversal = await tx.transactions.findSuccessfulReversal(
    reference.id,
  );
  return { reference, referenceEntry, existingReversal };
}
