import type { RequiredEntityData } from '@mikro-orm/core';
import type { LedgerDirection } from '../../../domain/ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry.js';
import type { WalletLedgerEntryRecord } from '../records/wallet-ledger-entry.record.js';
import { moneyFromColumns } from './money-columns.js';

export const walletLedgerEntryMapper = {
  toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => moneyFromColumns(amount, record.currency);
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      // Checked by the schema.
      direction: record.direction as LedgerDirection,
      amount: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },

  toData(
    entry: WalletLedgerEntry,
  ): RequiredEntityData<WalletLedgerEntryRecord> {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.amount.toProps().amount,
      currency: entry.amount.currency,
      balanceBefore: entry.balanceBefore.toProps().amount,
      balanceAfter: entry.balanceAfter.toProps().amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};
