import type { MigrationObject } from '@mikro-orm/core';
import { Migration0001Wallets } from './0001-wallets.js';
import { Migration0002WagerTransactions } from './0002-wager-transactions.js';
import { Migration0003WalletLedgerEntries } from './0003-wallet-ledger-entries.js';
import { Migration0004InboxOutbox } from './0004-inbox-outbox.js';
import { Migration0005CommitConsistency } from './0005-commit-consistency.js';
import { Migration0006WorkerIndexes } from './0006-worker-indexes.js';

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
  {
    name: 'Migration0003WalletLedgerEntries',
    class: Migration0003WalletLedgerEntries,
  },
  { name: 'Migration0004InboxOutbox', class: Migration0004InboxOutbox },
  {
    name: 'Migration0005CommitConsistency',
    class: Migration0005CommitConsistency,
  },
  { name: 'Migration0006WorkerIndexes', class: Migration0006WorkerIndexes },
];

/** The name of the last migration; readiness compares the database against it. */
export { LATEST_MIGRATION } from '../src/infrastructure/persistence/schema-version.js';
