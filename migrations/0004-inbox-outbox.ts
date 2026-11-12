import { Migration } from '@mikro-orm/migrations';

/**
 * The SQS inbox and the transactional outbox.
 *
 * The inbox row is inserted before its transaction row, in the same SQL
 * transaction, so its foreign key is checked at commit. The outbox has no
 * foreign key, so an event never waits on wallet rows; once published, an
 * event stays published.
 */
export class Migration0004InboxOutbox extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE inbox (
        consumer_name varchar(64) NOT NULL,
        message_id varchar(128) NOT NULL,
        payload_hash varchar(70) NOT NULL,
        idempotency_key varchar(255) NOT NULL,
        transaction_id uuid NOT NULL,
        received_at timestamptz(3) NOT NULL DEFAULT now(),
        processed_at timestamptz(3) NOT NULL DEFAULT now(),

        CONSTRAINT inbox_pkey PRIMARY KEY (consumer_name, message_id),
        CONSTRAINT inbox_transaction_id_fkey
          FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id)
          DEFERRABLE INITIALLY DEFERRED
      )`);

    this.addSql(`
      CREATE TABLE outbox (
        id uuid NOT NULL,
        aggregate_id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        event_type varchar(64) NOT NULL,
        event_version integer NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz(3) NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
        published_at timestamptz(3) NULL,
        last_error text NULL,

        CONSTRAINT outbox_pkey PRIMARY KEY (id),
        CONSTRAINT outbox_attempts_check CHECK (attempts >= 0),
        CONSTRAINT outbox_event_version_check CHECK (event_version >= 1)
      )`);

    this.addSql(`
      CREATE FUNCTION outbox_published_at_write_once() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.published_at IS NOT NULL
          AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox event % is already published', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        RETURN NEW;
      END $$`);

    this.addSql(`
      CREATE TRIGGER outbox_immutable_trg BEFORE UPDATE ON outbox
      FOR EACH ROW EXECUTE FUNCTION wagering_immutable_columns(
        'id', 'aggregate_id', 'wallet_id', 'event_type', 'event_version', 'payload', 'occurred_at')`);
    this.addSql(`
      CREATE TRIGGER outbox_published_at_trg BEFORE UPDATE ON outbox
      FOR EACH ROW EXECUTE FUNCTION outbox_published_at_write_once()`);
    this.addSql(`
      CREATE TRIGGER outbox_no_delete_trg BEFORE DELETE ON outbox
      FOR EACH ROW EXECUTE FUNCTION wagering_refuse()`);
    this.addSql(`
      CREATE TRIGGER outbox_no_truncate_trg BEFORE TRUNCATE ON outbox
      FOR EACH STATEMENT EXECUTE FUNCTION wagering_refuse()`);
  }

  override down(): void {
    this.addSql('DROP TABLE outbox');
    this.addSql('DROP FUNCTION outbox_published_at_write_once()');
    this.addSql('DROP TABLE inbox');
  }
}
