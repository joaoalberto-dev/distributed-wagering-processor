import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { WagerTransactionRecord } from './wager-transaction.record.js';

/**
 * The `wallet_ledger_entries` row, insert-only. `transaction_id` is declared
 * as a relation only so the flush inserts the transaction first.
 */
export const WalletLedgerEntryRecord = defineEntity({
  name: 'WalletLedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p
      .manyToOne(WagerTransactionRecord)
      .mapToPk()
      .fieldName('transaction_id'),
    direction: p.string(),
    amount: p.decimal('string').precision(14).scale(2),
    currency: p.string().length(3),
    balanceBefore: p.decimal('string').precision(14).scale(2),
    balanceAfter: p.decimal('string').precision(14).scale(2),
    walletVersion: p.integer(),
    createdAt: p.datetime(3),
  },
});

export type WalletLedgerEntryRecord = InferEntity<
  typeof WalletLedgerEntryRecord
>;
