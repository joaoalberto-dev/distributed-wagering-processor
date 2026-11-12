import { InboxRecord } from './inbox.record.js';
import { OutboxRecord } from './outbox.record.js';
import { WagerTransactionRecord } from './wager-transaction.record.js';
import { WalletLedgerEntryRecord } from './wallet-ledger-entry.record.js';
import { WalletRecord } from './wallet.record.js';

/** Every persistence record, for the ORM configuration. */
export const PERSISTENCE_RECORDS = [
  WalletRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  InboxRecord,
  OutboxRecord,
];
