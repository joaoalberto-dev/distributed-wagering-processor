import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** The `wallets` row. Money is a decimal string; the domain owns every rule. */
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balance: p.decimal('string').precision(14).scale(2),
    version: p.integer(),
    createdAt: p.datetime(3),
    updatedAt: p.datetime(3),
  },
});

export type WalletRecord = InferEntity<typeof WalletRecord>;
