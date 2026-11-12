import type { EventContext } from '../../domain/events/integration-event.js';
import {
  type WagerEvent,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wager-events.js';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry.js';
import { InvariantViolationError } from '../../domain/shared/domain-error.js';
import { WagerTransactionStatus } from '../../domain/transaction/transaction-status.js';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import type { IdGenerator } from '../ports/id-generator.js';

/** Tracing and time shared by every event of one outcome; each event gets its own ID. */
export type EventTracing = {
  readonly ids: IdGenerator;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: Date;
};

/** What the outcome left behind, read after the transition. */
export type OutcomeFacts = {
  readonly transaction: WagerTransaction;
  /** The entry when the balance moved. */
  readonly entry: WalletLedgerEntry | null;
  /** The expiry read from the database clock when the transaction starts waiting. */
  readonly referenceExpiresAt: Date | null;
};

/**
 * The events of one outcome (§13), in a fixed order: the transaction event,
 * then `WalletBalanceChanged` when the balance moved.
 */
export function buildEvents(
  facts: OutcomeFacts,
  tracing: EventTracing,
): WagerEvent[] {
  const ctx = (): EventContext => ({
    eventId: tracing.ids.uuidv7(),
    correlationId: tracing.correlationId,
    causationId: tracing.causationId,
    occurredAt: tracing.occurredAt,
  });
  const { transaction, entry } = facts;
  switch (transaction.status) {
    case WagerTransactionStatus.Processed: {
      const processed = WagerTransactionProcessed.from(transaction, ctx());
      return entry === null
        ? [processed]
        : [processed, WalletBalanceChanged.from(entry, ctx())];
    }
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, ctx())];
    case WagerTransactionStatus.Failed:
      return [WagerTransactionFailed.from(transaction, ctx())];
    case WagerTransactionStatus.PendingReference: {
      if (facts.referenceExpiresAt === null) {
        throw new InvariantViolationError(
          `transaction ${transaction.id}: a pending reference needs its expiry`,
        );
      }
      return [
        WagerTransactionPendingReference.from(
          transaction,
          facts.referenceExpiresAt,
          ctx(),
        ),
      ];
    }
    case WagerTransactionStatus.Pending:
      throw new InvariantViolationError(
        `transaction ${transaction.id}: a PENDING transaction has no events`,
      );
  }
}
