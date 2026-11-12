import { Migration } from '@mikro-orm/migrations';

/**
 * The append-only ledger. Each entry is one balance movement of one
 * transaction; `wallet_version` is the wallet's version after the entry.
 */
export class Migration0003WalletLedgerEntries extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction text NOT NULL,
        amount numeric(14,2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(14,2) NOT NULL,
        balance_after numeric(14,2) NOT NULL,
        wallet_version integer NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),

        CONSTRAINT wallet_ledger_entries_pkey PRIMARY KEY (id),
        CONSTRAINT wallet_ledger_entries_transaction_id_key UNIQUE (transaction_id),
        CONSTRAINT wallet_ledger_entries_wallet_id_wallet_version_key
          UNIQUE (wallet_id, wallet_version),
        CONSTRAINT wallet_ledger_entries_transaction_id_wallet_id_fkey
          FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),

        CONSTRAINT wallet_ledger_entries_direction_check
          CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT wallet_ledger_entries_currency_check
          CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallet_ledger_entries_amount_check CHECK (amount > 0),
        CONSTRAINT wallet_ledger_entries_balance_check
          CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT wallet_ledger_entries_arithmetic_check CHECK (
          balance_after = CASE direction
            WHEN 'CREDIT' THEN balance_before + amount
            ELSE balance_before - amount
          END
        ),
        CONSTRAINT wallet_ledger_entries_wallet_version_check CHECK (wallet_version >= 1)
      )`);

    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_trg BEFORE UPDATE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION wagering_refuse()`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_delete_trg BEFORE DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION wagering_refuse()`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION wagering_refuse()`);
  }

  override down(): void {
    this.addSql('DROP TABLE wallet_ledger_entries');
  }
}
