import type { RequiredEntityData } from '@mikro-orm/core';
import type { FailureCode } from '../../../domain/failure-code.js';
import type { WagerTransactionKind } from '../../../domain/transaction/transaction-kind.js';
import type { WagerTransactionStatus } from '../../../domain/transaction/transaction-status.js';
import { WagerTransaction } from '../../../domain/transaction/wager-transaction.js';
import type { WagerTransactionRecord } from '../records/wager-transaction.record.js';
import { moneyFromColumns } from './money-columns.js';

/** Scheduling columns of a `PENDING_REFERENCE` row, from the database clock. */
export type PendingTimes = {
  readonly nextReferenceAttemptAt: Date;
  readonly referenceExpiresAt: Date;
};

export const wagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const resultBalance =
      record.resultBalanceAmount === null ||
      record.resultBalanceAmount === undefined
        ? null
        : moneyFromColumns(
            record.resultBalanceAmount,
            record.resultBalanceCurrency ?? record.currency,
          );
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId ?? null,
      externalTransactionId: record.externalTransactionId ?? null,
      idempotencyKey: record.idempotencyKey ?? null,
      payloadHash: record.payloadHash ?? null,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId ?? null,
      gameId: record.gameId ?? null,
      // The kind, status, and failure code columns are checked by the schema.
      kind: record.kind as WagerTransactionKind,
      money: moneyFromColumns(record.amount, record.currency),
      referenceExternalTransactionId:
        record.referenceExternalTransactionId ?? null,
      referenceTransactionId: record.referenceTransactionId ?? null,
      status: record.status as WagerTransactionStatus,
      failureCode: (record.failureCode ?? null) as FailureCode | null,
      resultDetails: record.resultDetails ?? null,
      resultBalance,
      correlationId: record.correlationId,
      attempts: record.attempts,
      createdAt: record.createdAt,
      processedAt: record.processedAt ?? null,
    });
  },

  toData(
    transaction: WagerTransaction,
    pending?: PendingTimes,
  ): RequiredEntityData<WagerTransactionRecord> {
    const state = transaction.toState();
    const money = state.money.toProps();
    const balance = state.resultBalance?.toProps() ?? null;
    return {
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId,
      gameId: state.gameId,
      kind: state.kind,
      amount: money.amount,
      currency: money.currency,
      referenceExternalTransactionId: state.referenceExternalTransactionId,
      referenceTransactionId: state.referenceTransactionId,
      status: state.status,
      failureCode: state.failureCode,
      resultDetails: state.resultDetails,
      resultBalanceAmount: balance?.amount ?? null,
      resultBalanceCurrency: balance?.currency ?? null,
      correlationId: state.correlationId,
      attempts: state.attempts,
      nextReferenceAttemptAt: pending?.nextReferenceAttemptAt ?? null,
      referenceExpiresAt: pending?.referenceExpiresAt ?? null,
      createdAt: state.createdAt,
      updatedAt: state.processedAt ?? state.createdAt,
      processedAt: state.processedAt,
    };
  },

  /**
   * Copies the result of a status change onto a managed record. `attempts`
   * and the scheduling columns are not copied: only the conditional raw
   * updates of the worker write them.
   */
  applyTo(record: WagerTransactionRecord, transaction: WagerTransaction): void {
    const state = transaction.toState();
    const balance = state.resultBalance?.toProps() ?? null;
    record.status = state.status;
    record.failureCode = state.failureCode;
    record.resultDetails = state.resultDetails;
    record.resultBalanceAmount = balance?.amount ?? null;
    record.resultBalanceCurrency = balance?.currency ?? null;
    record.referenceTransactionId = state.referenceTransactionId;
    record.processedAt = state.processedAt;
    if (state.processedAt !== null) record.updatedAt = state.processedAt;
  },
};
