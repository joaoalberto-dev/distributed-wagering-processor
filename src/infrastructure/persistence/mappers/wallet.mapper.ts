import type { RequiredEntityData } from '@mikro-orm/core';
import { Wallet } from '../../../domain/wallet/wallet.js';
import type { WalletRecord } from '../records/wallet.record.js';
import { moneyFromColumns } from './money-columns.js';

export const walletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: moneyFromColumns(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toData(wallet: Wallet): RequiredEntityData<WalletRecord> {
    const state = wallet.toState();
    return {
      id: state.id,
      playerId: state.playerId,
      currency: state.currency,
      balance: state.balance.toProps().amount,
      version: state.version,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  },

  /** Copies the mutable state onto a managed record; the flush writes what changed. */
  applyTo(record: WalletRecord, wallet: Wallet): void {
    record.balance = wallet.balance.toProps().amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
  },
};
