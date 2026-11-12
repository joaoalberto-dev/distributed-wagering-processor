import type { MigrationObject } from '@mikro-orm/core';
import { Migration0001Wallets } from './0001-wallets.js';
import { Migration0002WagerTransactions } from './0002-wager-transactions.js';

/**
 * Every migration, in the order it runs. Each entry names its class
 * explicitly, so the stored name survives bundling.
 */
export const migrations: MigrationObject[] = [
  { name: 'Migration0001Wallets', class: Migration0001Wallets },
  {
    name: 'Migration0002WagerTransactions',
    class: Migration0002WagerTransactions,
  },
];

/** The name of the last migration; readiness compares the database against it. */
export const LATEST_MIGRATION: string = 'Migration0002WagerTransactions';
