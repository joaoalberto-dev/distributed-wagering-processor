import { Migration } from '@mikro-orm/migrations';

const PROCESSED_OR_REJECTED = `
          WHEN status IN ('PROCESSED', 'REJECTED') THEN result_balance_amount IS NOT NULL
            AND result_balance_amount >= 0`;

const REST = `
            AND processed_at IS NOT NULL
          WHEN status = 'FAILED' THEN result_balance_amount IS NULL
            AND result_balance_currency IS NULL AND result_details IS NULL
            AND processed_at IS NOT NULL
          ELSE result_balance_amount IS NULL AND result_balance_currency IS NULL
            AND result_details IS NULL AND processed_at IS NULL
        END`;

/**
 * The result snapshot is the wallet's balance, so its currency is the
 * wallet's. A `CURRENCY_MISMATCH` rejection is the one result whose
 * operation currency differs from it: the snapshot currency must equal the
 * operation's only for `PROCESSED`, where D3 has passed. For `REJECTED` it
 * must be present.
 */
export class Migration0007RejectionSnapshotCurrency extends Migration {
  override up(): void {
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_result_check',
    );
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_result_check CHECK (
        CASE${PROCESSED_OR_REJECTED}
            AND result_balance_currency IS NOT NULL
            AND (status = 'REJECTED' OR result_balance_currency = currency)${REST}
      )`);
  }

  override down(): void {
    this.addSql(
      'ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_result_check',
    );
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_result_check CHECK (
        CASE${PROCESSED_OR_REJECTED}
            AND result_balance_currency IS NOT DISTINCT FROM currency${REST}
      )`);
  }
}
