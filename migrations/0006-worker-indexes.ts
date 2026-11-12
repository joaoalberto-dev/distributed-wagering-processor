import { Migration } from '@mikro-orm/migrations';

/**
 * Indexes for the pending-reference worker, the wake-up, and the outbox
 * publisher. Ledger reads by `(wallet_id, wallet_version)` already use the
 * index behind `wallet_ledger_entries_wallet_id_wallet_version_key`, and the
 * existing-reversal lookup uses `wager_transactions_reference_transaction_id_key`.
 */
export class Migration0006WorkerIndexes extends Migration {
  override up(): void {
    this.addSql(`
      CREATE INDEX wager_transactions_next_reference_attempt_at_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (provider_id, reference_external_transaction_id, wallet_id)
        WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX outbox_next_attempt_at_idx
        ON outbox (next_attempt_at)
        WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql('DROP INDEX outbox_next_attempt_at_idx');
    this.addSql('DROP INDEX wager_transactions_pending_reference_idx');
    this.addSql('DROP INDEX wager_transactions_next_reference_attempt_at_idx');
  }
}
