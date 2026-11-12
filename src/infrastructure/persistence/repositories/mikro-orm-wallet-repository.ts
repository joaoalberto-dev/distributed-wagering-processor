import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/repositories.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { walletMapper } from '../mappers/wallet.mapper.js';
import { WalletRecord } from '../records/wallet.record.js';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lock(id: string, mode: 'wait' | 'skip-locked'): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      {
        lockMode:
          mode === 'wait'
            ? LockMode.PESSIMISTIC_WRITE
            : LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return record === null ? null : walletMapper.toDomain(record);
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record === null ? null : walletMapper.toDomain(record);
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record === null ? null : walletMapper.toDomain(record);
  }

  insert(wallet: Wallet): Promise<void> {
    this.em.create(WalletRecord, walletMapper.toData(wallet));
    return Promise.resolve();
  }

  async save(wallet: Wallet): Promise<void> {
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    walletMapper.applyTo(record, wallet);
  }
}
