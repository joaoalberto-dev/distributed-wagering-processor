import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import type { ResultDetails } from '../../../domain/transaction/wager-transaction.js';
import { WalletRecord } from './wallet.record.js';

/**
 * The `wager_transactions` row. `wallet_id` is declared as a relation only so
 * the flush inserts the wallet first; it maps to the plain ID. `status` is a
 * concurrency check: a status change is written only if the row still has the
 * status it was loaded with.
 */
export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().length(128).nullable(),
    externalTransactionId: p.string().length(128).nullable(),
    idempotencyKey: p.string().length(255).nullable(),
    payloadHash: p.string().length(70).nullable(),
    walletId: p.manyToOne(WalletRecord).mapToPk().fieldName('wallet_id'),
    playerId: p.uuid(),
    roundId: p.string().length(128).nullable(),
    gameId: p.string().length(128).nullable(),
    kind: p.string(),
    amount: p.decimal('string').precision(14).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.string().length(128).nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string().concurrencyCheck(),
    failureCode: p.string().nullable(),
    resultDetails: p.json<ResultDetails>().nullable(),
    resultBalanceAmount: p.decimal('string').precision(14).scale(2).nullable(),
    resultBalanceCurrency: p.string().length(3).nullable(),
    correlationId: p.string().length(128),
    attempts: p.integer(),
    nextReferenceAttemptAt: p.datetime(3).nullable(),
    referenceExpiresAt: p.datetime(3).nullable(),
    createdAt: p.datetime(3),
    updatedAt: p.datetime(3),
    processedAt: p.datetime(3).nullable(),
  },
});

export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;
