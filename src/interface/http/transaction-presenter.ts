import { HttpStatus } from '@nestjs/common';
import type { TransactionView } from '../../application/ports/queries.js';
import type { MoneyProps } from '../../domain/money/money.js';

/** The transaction result body of `POST /wagering/transactions` (§7). */
export type TransactionResultBody = {
  readonly transactionId: string;
  readonly status: TransactionView['status'];
  /** The snapshot when decided; null while pending and for `FAILED`. */
  readonly balance: MoneyProps | null;
  readonly failureCode?: string;
  readonly details?: object;
  readonly idempotentReplay: boolean;
};

/** The transaction resource of the two `GET` routes (§7). */
export type TransactionBody = {
  readonly id: string;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly status: string;
  readonly failureCode?: string;
  readonly details?: object;
  readonly resultBalance: MoneyProps | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly processedAt?: string;
};

/**
 * The status of a result, from the stored state when it is served:
 * `PROCESSED` 200, `PENDING_REFERENCE` 202, `REJECTED` and `FAILED` 422.
 */
export function resultStatus(view: TransactionView): number {
  switch (view.status) {
    case 'PROCESSED':
      return HttpStatus.OK;
    case 'PENDING_REFERENCE':
      return HttpStatus.ACCEPTED;
    case 'REJECTED':
    case 'FAILED':
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case 'PENDING':
      throw new Error(`transaction ${view.id}: PENDING is never served`);
  }
}

export function transactionLocation(view: TransactionView): string {
  return `/wagering/transactions/${view.id}`;
}

export function presentResult(
  view: TransactionView,
  replay: boolean,
): TransactionResultBody {
  return {
    transactionId: view.id,
    status: view.status,
    balance: view.resultBalance,
    ...(view.failureCode === null ? {} : { failureCode: view.failureCode }),
    ...(view.details === null ? {} : { details: view.details }),
    idempotentReplay: replay,
  };
}

export function presentTransaction(view: TransactionView): TransactionBody {
  return {
    id: view.id,
    providerId: view.providerId,
    externalTransactionId: view.externalTransactionId,
    playerId: view.playerId,
    walletId: view.walletId,
    roundId: view.roundId,
    gameId: view.gameId,
    kind: view.kind,
    money: view.money,
    ...(view.referenceExternalTransactionId === null
      ? {}
      : {
          referenceExternalTransactionId: view.referenceExternalTransactionId,
        }),
    ...(view.referenceTransactionId === null
      ? {}
      : { referenceTransactionId: view.referenceTransactionId }),
    status: view.status,
    ...(view.failureCode === null ? {} : { failureCode: view.failureCode }),
    ...(view.details === null ? {} : { details: view.details }),
    resultBalance: view.resultBalance,
    attempts: view.attempts,
    createdAt: view.createdAt.toISOString(),
    ...(view.processedAt === null
      ? {}
      : { processedAt: view.processedAt.toISOString() }),
  };
}
