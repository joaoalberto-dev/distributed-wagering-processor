import { Migration } from '@mikro-orm/migrations';

/**
 * The `wallets` table, plus two trigger functions every later table reuses:
 * `wagering_refuse()` rejects the operation that fires it, and
 * `wagering_immutable_columns(col, …)` rejects an update that changes any of
 * the named columns. Both raise SQLSTATE 23000 and report the trigger name as
 * the constraint, so a violation names its rule like a `CHECK` does.
 */
export class Migration0001Wallets extends Migration {
  override up(): void {
    this.addSql(`
      CREATE FUNCTION wagering_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is not allowed', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
      END $$`);

    this.addSql(`
      CREATE FUNCTION wagering_immutable_columns() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        column_name text;
      BEGIN
        FOREACH column_name IN ARRAY TG_ARGV LOOP
          IF to_jsonb(NEW) -> column_name IS DISTINCT FROM to_jsonb(OLD) -> column_name THEN
            RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, column_name
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
          END IF;
        END LOOP;
        RETURN NEW;
      END $$`);

    this.addSql(`
      CREATE TABLE wallets (
        id uuid NOT NULL,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(14,2) NOT NULL,
        version integer NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT wallets_pkey PRIMARY KEY (id),
        CONSTRAINT wallets_player_id_currency_key UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_check CHECK (balance >= 0),
        CONSTRAINT wallets_version_check CHECK (version >= 1),
        CONSTRAINT wallets_currency_check CHECK (currency ~ '^[A-Z]{3}$')
      )`);

    this.addSql(`
      CREATE TRIGGER wallets_immutable_trg BEFORE UPDATE ON wallets
      FOR EACH ROW EXECUTE FUNCTION wagering_immutable_columns('id', 'player_id', 'currency', 'created_at')`);
    this.addSql(`
      CREATE TRIGGER wallets_no_delete_trg BEFORE DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION wagering_refuse()`);
    this.addSql(`
      CREATE TRIGGER wallets_no_truncate_trg BEFORE TRUNCATE ON wallets
      FOR EACH STATEMENT EXECUTE FUNCTION wagering_refuse()`);
  }

  override down(): void {
    this.addSql('DROP TABLE wallets');
    this.addSql('DROP FUNCTION wagering_immutable_columns()');
    this.addSql('DROP FUNCTION wagering_refuse()');
  }
}
