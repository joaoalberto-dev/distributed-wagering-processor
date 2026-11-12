import type { MigrationObject } from '@mikro-orm/core';
import { Migration0001Wallets } from './0001-wallets.js';

/**
 * Every migration, in the order it runs. Each entry names its class
 * explicitly, so the stored name survives bundling.
 */
export const migrations: MigrationObject[] = [
  { name: 'Migration0001Wallets', class: Migration0001Wallets },
];

/** The name of the last migration; readiness compares the database against it. */
export const LATEST_MIGRATION: string = 'Migration0001Wallets';
