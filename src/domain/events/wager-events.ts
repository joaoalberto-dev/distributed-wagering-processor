import type { RejectionCode } from '../failure-code.js';
import type { LedgerDirection } from '../ledger/ledger-direction.js';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import type { MoneyProps } from '../money/money.js';
import { InvariantViolationError } from '../shared/domain-error.js';
import type { WagerTransactionKind } from '../transaction/transaction-kind.js';
import type { WagerTransactionStatus } from '../transaction/transaction-status.js';
import type {
  ResultDetails,
  WagerTransaction,
} from '../transaction/wager-transaction.js';
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event.js';

type ProviderOperation = {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
};

export type WagerTransactionProcessedData = {
  readonly transactionId: string;
  /** Absent for `OPENING`. */
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  /** The balance snapshot after the operation. */
  readonly balance: MoneyProps;
  readonly details?: ResultDetails;
};

export type WalletBalanceChangedData = {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
};

export type WagerTransactionRejectedData = ProviderOperation & {
  readonly failureCode: RejectionCode;
  readonly balance: MoneyProps;
  readonly details?: ResultDetails;
};

export type WagerTransactionPendingReferenceData = ProviderOperation & {
  readonly referenceExternalTransactionId: string;
  /** ISO-8601, from the database clock. */
  readonly referenceExpiresAt: string;
};

export type WagerTransactionFailedData = ProviderOperation & {
  readonly failureCode: 'PROCESSING_FAILED';
};

function assertStatus(
  transaction: WagerTransaction,
  status: WagerTransactionStatus,
  event: string,
): void {
  if (transaction.status !== status) {
    throw new InvariantViolationError(
      `${event} needs a ${status} transaction, got ${transaction.status}`,
    );
  }
}

function providerOperation(
  transaction: WagerTransaction,
  event: string,
): ProviderOperation {
  const { providerId, externalTransactionId } = transaction;
  if (providerId === null || externalTransactionId === null) {
    throw new InvariantViolationError(`${event} needs a provider operation`);
  }
  return {
    transactionId: transaction.id,
    providerId,
    externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    kind: transaction.kind,
    money: transaction.money.toProps(),
  };
}

function resultBalance(
  transaction: WagerTransaction,
  event: string,
): MoneyProps {
  if (transaction.resultBalance === null) {
    throw new InvariantViolationError(`${event} needs a balance snapshot`);
  }
  return transaction.resultBalance.toProps();
}

function withDetails<T extends object>(
  data: T,
  details: ResultDetails | null,
): T & { details?: ResultDetails } {
  return details === null ? data : { ...data, details };
}

function props<T>(
  aggregateId: string,
  data: T,
  ctx: EventContext,
): IntegrationEventProps<T> {
  return { ...ctx, aggregateId, data };
}

/** Any `PROCESSED` transaction, including `LOSS` and `OPENING`. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(p);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const name = 'WagerTransactionProcessed';
    assertStatus(transaction, 'PROCESSED', name);
    const { providerId, externalTransactionId } = transaction;
    const data: WagerTransactionProcessedData = {
      transactionId: transaction.id,
      ...(providerId === null ? {} : { providerId }),
      ...(externalTransactionId === null ? {} : { externalTransactionId }),
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      kind: transaction.kind,
      money: transaction.money.toProps(),
      balance: resultBalance(transaction, name),
    };
    return new WagerTransactionProcessed(
      props(transaction.id, withDetails(data, transaction.resultDetails), ctx),
    );
  }
}

/** Only when the balance moves: one per ledger entry. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WalletBalanceChangedData>) {
    super(p);
  }

  static from(
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(
      props(
        entry.walletId,
        {
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.amount.toProps(),
          balanceBefore: entry.balanceBefore.toProps(),
          balanceAfter: entry.balanceAfter.toProps(),
          walletVersion: entry.walletVersion,
        },
        ctx,
      ),
    );
  }
}

/** Any `REJECTED` transaction, including TTL expiry. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(p);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const name = 'WagerTransactionRejected';
    assertStatus(transaction, 'REJECTED', name);
    const failureCode = transaction.failureCode;
    if (failureCode === null || failureCode === 'PROCESSING_FAILED') {
      throw new InvariantViolationError(`${name} needs a rejection code`);
    }
    const data: WagerTransactionRejectedData = {
      ...providerOperation(transaction, name),
      failureCode,
      balance: resultBalance(transaction, name),
    };
    return new WagerTransactionRejected(
      props(transaction.id, withDetails(data, transaction.resultDetails), ctx),
    );
  }
}

/** On entering `PENDING_REFERENCE`, once. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(
    p: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(p);
  }

  static from(
    transaction: WagerTransaction,
    referenceExpiresAt: Date,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const name = 'WagerTransactionPendingReference';
    assertStatus(transaction, 'PENDING_REFERENCE', name);
    const reference = transaction.referenceExternalTransactionId;
    if (reference === null) {
      throw new InvariantViolationError(`${name} needs a reference`);
    }
    return new WagerTransactionPendingReference(
      props(
        transaction.id,
        {
          ...providerOperation(transaction, name),
          referenceExternalTransactionId: reference,
          referenceExpiresAt: referenceExpiresAt.toISOString(),
        },
        ctx,
      ),
    );
  }
}

/** On `FAILED`: an addition to the challenge's minimum set. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  private constructor(p: IntegrationEventProps<WagerTransactionFailedData>) {
    super(p);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionFailed {
    const name = 'WagerTransactionFailed';
    assertStatus(transaction, 'FAILED', name);
    return new WagerTransactionFailed(
      props(
        transaction.id,
        {
          ...providerOperation(transaction, name),
          failureCode: 'PROCESSING_FAILED',
        },
        ctx,
      ),
    );
  }
}

export type WagerEvent =
  | WagerTransactionProcessed
  | WalletBalanceChanged
  | WagerTransactionRejected
  | WagerTransactionPendingReference
  | WagerTransactionFailed;
