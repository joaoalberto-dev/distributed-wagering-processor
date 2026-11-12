import { Migration } from '@mikro-orm/migrations';

/**
 * The `wager_transactions` table: provider operations and the internal
 * `OPENING` credit, with their result. The schema repeats the per-kind rules
 * and the persisted lifecycle, so manual SQL as the app role cannot store a
 * row the domain would never produce.
 */
export class Migration0002WagerTransactions extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid NOT NULL,
        provider_id varchar(128) NULL,
        external_transaction_id varchar(128) NULL,
        idempotency_key varchar(255) NULL,
        payload_hash varchar(70) NULL,
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        round_id varchar(128) NULL,
        game_id varchar(128) NULL,
        kind text NOT NULL,
        amount numeric(14,2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id varchar(128) NULL,
        reference_transaction_id uuid NULL,
        status text NOT NULL,
        failure_code text NULL,
        result_details jsonb NULL,
        result_balance_amount numeric(14,2) NULL,
        result_balance_currency char(3) NULL,
        correlation_id varchar(128) NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_reference_attempt_at timestamptz(3) NULL,
        reference_expires_at timestamptz(3) NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_at timestamptz(3) NOT NULL DEFAULT now(),
        processed_at timestamptz(3) NULL,

        CONSTRAINT wager_transactions_pkey PRIMARY KEY (id),
        CONSTRAINT wager_transactions_provider_id_idempotency_key_key
          UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_transactions_provider_id_external_transaction_id_key
          UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_transactions_id_wallet_id_key UNIQUE (id, wallet_id),

        CONSTRAINT wager_transactions_wallet_id_fkey
          FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wager_transactions_reference_transaction_id_wallet_id_fkey
          FOREIGN KEY (reference_transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),

        CONSTRAINT wager_transactions_kind_check
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_check
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_status_persisted_check
          CHECK (status <> 'PENDING'),
        CONSTRAINT wager_transactions_currency_check
          CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_transactions_attempts_check
          CHECK (attempts >= 0),
        CONSTRAINT wager_transactions_amount_check
          CHECK (CASE WHEN kind = 'LOSS' THEN amount >= 0 ELSE amount > 0 END),
        CONSTRAINT wager_transactions_reference_check CHECK (
          CASE
            WHEN kind IN ('REFUND', 'ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
            WHEN kind IN ('OPENING', 'BET') THEN reference_external_transaction_id IS NULL
              AND reference_transaction_id IS NULL
            ELSE true
          END
          AND (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL)
          AND (reference_transaction_id IS NULL OR reference_transaction_id <> id)
          AND (reference_external_transaction_id IS NULL
            OR reference_external_transaction_id <> external_transaction_id)
        ),
        CONSTRAINT wager_transactions_provider_fields_check CHECK (
          CASE
            WHEN kind = 'OPENING' THEN provider_id IS NULL
              AND external_transaction_id IS NULL AND idempotency_key IS NULL
              AND payload_hash IS NULL AND round_id IS NULL AND game_id IS NULL
              AND status = 'PROCESSED'
            ELSE provider_id IS NOT NULL
              AND external_transaction_id IS NOT NULL AND idempotency_key IS NOT NULL
              AND payload_hash IS NOT NULL AND round_id IS NOT NULL AND game_id IS NOT NULL
          END
        ),
        CONSTRAINT wager_transactions_failure_code_check CHECK (
          CASE status
            WHEN 'REJECTED' THEN failure_code IS NOT NULL AND failure_code IN (
              'WALLET_PLAYER_MISMATCH', 'CURRENCY_MISMATCH', 'REFERENCE_MISMATCH',
              'REFERENCE_INVALID', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED',
              'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'BALANCE_LIMIT_EXCEEDED',
              'REFERENCE_NOT_FOUND', 'REFERENCE_NOT_READY')
            WHEN 'FAILED' THEN failure_code IS NOT DISTINCT FROM 'PROCESSING_FAILED'
            ELSE failure_code IS NULL
          END
        ),
        CONSTRAINT wager_transactions_result_check CHECK (
          CASE
            WHEN status IN ('PROCESSED', 'REJECTED') THEN result_balance_amount IS NOT NULL
              AND result_balance_amount >= 0
              AND result_balance_currency IS NOT DISTINCT FROM currency
              AND processed_at IS NOT NULL
            WHEN status = 'FAILED' THEN result_balance_amount IS NULL
              AND result_balance_currency IS NULL AND result_details IS NULL
              AND processed_at IS NOT NULL
            ELSE result_balance_amount IS NULL AND result_balance_currency IS NULL
              AND result_details IS NULL AND processed_at IS NULL
          END
        ),
        CONSTRAINT wager_transactions_scheduling_check CHECK (
          status <> 'PENDING_REFERENCE' OR (
            reference_external_transaction_id IS NOT NULL
            AND next_reference_attempt_at IS NOT NULL
            AND reference_expires_at IS NOT NULL
          )
        )
      )`);

    // At most one successful direct reversal (REFUND or ROLLBACK) per transaction (D9).
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_reference_transaction_id_key
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')`);
    // At most one OPENING credit per wallet.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_opening_wallet_id_key
        ON wager_transactions (wallet_id)
        WHERE kind = 'OPENING'`);

    this.addSql(`
      CREATE FUNCTION wager_transactions_lifecycle() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        mutable text[];
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status NOT IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE') THEN
            RAISE EXCEPTION 'a transaction cannot be inserted as %', NEW.status
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
          END IF;
          RETURN NEW;
        END IF;

        IF OLD.status <> 'PENDING_REFERENCE' THEN
          RAISE EXCEPTION 'transaction % is % and can no longer change', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        IF NEW IS NOT DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'transaction %: an update must change something', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;

        IF NEW.status = 'PENDING_REFERENCE' THEN
          mutable := ARRAY['attempts', 'next_reference_attempt_at', 'updated_at'];
        ELSIF NEW.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          mutable := ARRAY['status', 'failure_code', 'result_details', 'result_balance_amount',
            'result_balance_currency', 'reference_transaction_id', 'processed_at', 'updated_at'];
        ELSE
          RAISE EXCEPTION 'transaction %: % to % is not a lifecycle edge', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;

        IF to_jsonb(NEW) - mutable IS DISTINCT FROM to_jsonb(OLD) - mutable THEN
          RAISE EXCEPTION 'transaction %: % to % changes a column that edge does not allow',
            OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_NAME;
        END IF;
        RETURN NEW;
      END $$`);

    // Row triggers of one event fire in name order: identity, then lifecycle.
    this.addSql(`
      CREATE TRIGGER wager_transactions_identity_trg BEFORE UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION wagering_immutable_columns(
        'id', 'provider_id', 'external_transaction_id', 'idempotency_key', 'payload_hash',
        'wallet_id', 'player_id', 'round_id', 'game_id', 'kind', 'amount', 'currency',
        'reference_external_transaction_id', 'correlation_id', 'created_at')`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_lifecycle_trg BEFORE INSERT OR UPDATE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION wager_transactions_lifecycle()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_delete_trg BEFORE DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION wagering_refuse()`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_no_truncate_trg BEFORE TRUNCATE ON wager_transactions
      FOR EACH STATEMENT EXECUTE FUNCTION wagering_refuse()`);
  }

  override down(): void {
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP FUNCTION wager_transactions_lifecycle()');
  }
}
