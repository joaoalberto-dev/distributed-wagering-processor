import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../../application/ports/repositories.js';
import type { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry.js';
import { walletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper.js';
import { WalletLedgerEntryRecord } from '../records/wallet-ledger-entry.record.js';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): Promise<void> {
    this.em.create(
      WalletLedgerEntryRecord,
      walletLedgerEntryMapper.toData(entry),
    );
    return Promise.resolve();
  }

  async findByTransactionId(
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const record = await this.em.findOne(WalletLedgerEntryRecord, {
      transactionId,
    });
    return record === null ? null : walletLedgerEntryMapper.toDomain(record);
  }
}
