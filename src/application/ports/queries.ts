import type { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type { FailureCode } from '../../domain/failure-code.js';
import type { WagerTransactionKind } from '../../domain/transaction/transaction-kind.js';
import type { WagerTransactionStatus } from '../../domain/transaction/transaction-status.js';
import type { ResultDetails } from '../../domain/transaction/wager-transaction.js';

/** `GET /wallets/:walletId`. */
export type WalletView = {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
};

/** One item of `GET /wallets/:walletId/ledger`. */
export type LedgerItemView = {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: Date;
};

/** The transaction resource (§7); provider fields are null only for `OPENING`. */
export type TransactionView = {
  readonly id: string;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly details: ResultDetails | null;
  readonly resultBalance: MoneyProps | null;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
};

/**
 * The read side: no lock, one short read-only transaction per call. Errors
 * leave classified, like the unit of work's.
 */
export interface QueryPort {
  wallet(id: string): Promise<WalletView | null>;
  /** Up to `limit` entries with `wallet_version > afterVersion`, ascending. */
  ledgerPage(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<LedgerItemView[]>;
  transaction(id: string): Promise<TransactionView | null>;
  transactionByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<TransactionView | null>;
}

export const QUERY_PORT = Symbol('QueryPort');
