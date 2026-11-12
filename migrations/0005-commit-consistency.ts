import { Migration } from '@mikro-orm/migrations';

/**
 * Deferred constraint triggers that check, at commit, that balances and the
 * ledger agree:
 *
 * - tip: each touched wallet's balance and version equal its latest entry's
 *   `balance_after` and `wallet_version` (0 and 1 with no entries);
 * - chain: each new entry continues the previous one of its wallet;
 * - transaction: each new entry belongs to a `PROCESSED` transaction of a kind
 *   that moves the balance, with the same amount and currency;
 * - direction: the entry's direction matches the kind, and a `ROLLBACK` is the
 *   opposite of the entry it reverses;
 * - entry: each transaction that becomes `PROCESSED` with a kind that moves
 *   the balance has its ledger entry.
 *
 * With tip and chain checked at every commit, "balance = sum of the ledger"
 * holds by induction for every write that goes through the triggers. Messages
 * carry IDs and versions, never amounts.
 */
export class Migration0005CommitConsistency extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION wagering_check_wallet_tip(p_wallet_id uuid, p_trigger text) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        wallet record;
        tip record;
      BEGIN
        SELECT balance, version INTO wallet FROM wallets WHERE id = p_wallet_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'wallet % does not exist', p_wallet_id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = p_trigger;
        END IF;

        SELECT balance_after, wallet_version INTO tip
          FROM wallet_ledger_entries
          WHERE wallet_id = p_wallet_id
          ORDER BY wallet_version DESC
          LIMIT 1;
        IF NOT FOUND THEN
          IF wallet.balance <> 0 OR wallet.version <> 1 THEN
            RAISE EXCEPTION 'wallet % at version % has no ledger entry for its balance',
              p_wallet_id, wallet.version
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = p_trigger;
          END IF;
        ELSIF wallet.balance <> tip.balance_after OR wallet.version <> tip.wallet_version THEN
          RAISE EXCEPTION 'wallet % at version % does not match its latest ledger entry (version %)',
            p_wallet_id, wallet.version, tip.wallet_version
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = p_trigger;
        END IF;
      END $$`);

    this.addSql(`
      CREATE FUNCTION wallets_consistency() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM wagering_check_wallet_tip(NEW.id, TG_NAME);
        RETURN NULL;
      END $$`);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_consistency() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        operation record;
        wallet_currency text;
        referenced_direction text;
        expected_direction text;
        previous record;
      BEGIN
        -- Transaction: PROCESSED, of a kind that moves the balance, same amount and currency.
        SELECT kind, status, amount, currency, reference_transaction_id INTO operation
          FROM wager_transactions WHERE id = NEW.transaction_id;
        IF operation.status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'ledger entry % belongs to a % transaction', NEW.id, operation.status
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        IF operation.kind = 'LOSS' THEN
          RAISE EXCEPTION 'ledger entry %: a LOSS never moves the balance', NEW.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        IF operation.amount <> NEW.amount OR operation.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % differs from its transaction in amount or currency', NEW.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % is not in its wallet currency', NEW.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;

        -- Direction: by kind; a ROLLBACK inverts the entry it reverses.
        IF operation.kind = 'ROLLBACK' THEN
          SELECT direction INTO referenced_direction
            FROM wallet_ledger_entries WHERE transaction_id = operation.reference_transaction_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'ledger entry %: the rolled-back transaction has no entry', NEW.id
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
          END IF;
          expected_direction := CASE referenced_direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END;
        ELSE
          expected_direction := CASE operation.kind WHEN 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
        END IF;
        IF NEW.direction <> expected_direction THEN
          RAISE EXCEPTION 'ledger entry % of a % must be a %', NEW.id, operation.kind, expected_direction
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;

        -- Chain: version 1 is the OPENING credit from zero; any other version continues
        -- the previous entry, or starts from zero at version 2 of a wallet opened at zero.
        IF NEW.wallet_version = 1 THEN
          IF operation.kind <> 'OPENING' OR NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'ledger entry %: version 1 must be the OPENING credit from zero', NEW.id
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
          END IF;
        ELSE
          IF operation.kind = 'OPENING' THEN
            RAISE EXCEPTION 'ledger entry %: the OPENING credit must be version 1', NEW.id
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
          END IF;
          SELECT balance_after INTO previous
            FROM wallet_ledger_entries
            WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
          IF FOUND THEN
            IF NEW.balance_before <> previous.balance_after THEN
              RAISE EXCEPTION 'ledger entry % (version %) does not continue version %',
                NEW.id, NEW.wallet_version, NEW.wallet_version - 1
                USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
            END IF;
          ELSIF NEW.wallet_version = 2 THEN
            IF NEW.balance_before <> 0 THEN
              RAISE EXCEPTION 'ledger entry % (version 2) of a wallet opened at zero must start from zero', NEW.id
                USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
            END IF;
          ELSE
            RAISE EXCEPTION 'ledger entry % (version %) leaves a gap: version % is missing',
              NEW.id, NEW.wallet_version, NEW.wallet_version - 1
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
          END IF;
        END IF;

        -- Tip: the entry's wallet ends the transaction in agreement with its ledger.
        PERFORM wagering_check_wallet_tip(NEW.wallet_id, TG_NAME);
        RETURN NULL;
      END $$`);

    this.addSql(`
      CREATE FUNCTION wager_transactions_consistency() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'PROCESSED' AND NEW.kind <> 'LOSS' AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = NEW.id
        ) THEN
          RAISE EXCEPTION 'transaction % is a PROCESSED % without a ledger entry', NEW.id, NEW.kind
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        RETURN NULL;
      END $$`);

    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_consistency_trg
      AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION wallets_consistency()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_entries_consistency_trg
      AFTER INSERT ON wallet_ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_consistency()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wager_transactions_consistency_trg
      AFTER INSERT OR UPDATE OF status ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION wager_transactions_consistency()`);
  }

  override down(): void {
    this.addSql(
      'DROP TRIGGER wager_transactions_consistency_trg ON wager_transactions',
    );
    this.addSql(
      'DROP TRIGGER wallet_ledger_entries_consistency_trg ON wallet_ledger_entries',
    );
    this.addSql('DROP TRIGGER wallets_consistency_trg ON wallets');
    this.addSql('DROP FUNCTION wager_transactions_consistency()');
    this.addSql('DROP FUNCTION wallet_ledger_entries_consistency()');
    this.addSql('DROP FUNCTION wallets_consistency()');
    this.addSql('DROP FUNCTION wagering_check_wallet_tip(uuid, text)');
  }
}
