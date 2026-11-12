import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerAggregate,
  ReconciliationReader,
} from '../../../application/ports/repositories.js';
import { query } from './sql.js';

type AggregateRow = {
  stored_balance: string;
  currency: string;
  stored_version: number;
  ledger_sum_minor: string;
  entry_count: number;
  min_version: number | null;
  max_version: number | null;
  has_opening: boolean;
  missing_versions: string;
  first_balance_before: string | null;
  chain_breaks: number;
};

/** At most this many missing versions are listed in a `CHAIN_GAP`. */
const MISSING_VERSIONS_LIMIT = 100;

/**
 * One wallet's ledger aggregates in a single statement: no entry is loaded
 * into memory. Run it in a `read-only-snapshot` unit of work, so the wallet
 * row and the entries come from the same snapshot.
 */
export class SqlReconciliationReader implements ReconciliationReader {
  constructor(private readonly em: EntityManager) {}

  async aggregate(walletId: string): Promise<LedgerAggregate | null> {
    const [row] = await query<AggregateRow>(
      this.em,
      `WITH entries AS (
         SELECT e.wallet_version, e.direction, e.amount, e.balance_before,
                lag(e.balance_after) OVER (ORDER BY e.wallet_version) AS previous_after,
                t.kind
           FROM wallet_ledger_entries e
           JOIN wager_transactions t ON t.id = e.transaction_id
          WHERE e.wallet_id = ?
       )
       SELECT w.balance::text AS stored_balance,
              w.currency::text AS currency,
              w.version AS stored_version,
              (SELECT (COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
                       * 100)::bigint::text FROM entries) AS ledger_sum_minor,
              (SELECT count(*)::int FROM entries) AS entry_count,
              (SELECT min(wallet_version) FROM entries) AS min_version,
              (SELECT max(wallet_version) FROM entries) AS max_version,
              (SELECT COALESCE(bool_or(kind = 'OPENING'), false) FROM entries) AS has_opening,
              (SELECT COALESCE(string_agg(v::text, ',' ORDER BY v), '') FROM (
                 SELECT v FROM generate_series(
                          (SELECT CASE WHEN bool_or(kind = 'OPENING') THEN 1 ELSE 2 END FROM entries),
                          (SELECT max(wallet_version) FROM entries)) AS v
                  WHERE NOT EXISTS (SELECT 1 FROM entries WHERE wallet_version = v)
                  ORDER BY v
                  LIMIT ${MISSING_VERSIONS_LIMIT}) AS missing) AS missing_versions,
              (SELECT balance_before::text FROM entries ORDER BY wallet_version LIMIT 1)
                AS first_balance_before,
              (SELECT count(*)::int FROM entries
                WHERE previous_after IS NOT NULL AND balance_before <> previous_after) AS chain_breaks
         FROM wallets w
        WHERE w.id = ?`,
      [walletId, walletId],
    );
    if (row === undefined) return null;
    return {
      storedBalance: row.stored_balance,
      currency: row.currency,
      storedVersion: row.stored_version,
      ledgerSumMinor: BigInt(row.ledger_sum_minor),
      entryCount: row.entry_count,
      minVersion: row.min_version,
      maxVersion: row.max_version,
      hasOpening: row.has_opening,
      missingVersions:
        row.missing_versions === ''
          ? []
          : row.missing_versions.split(',').map(Number),
      firstBalanceBefore: row.first_balance_before,
      chainBreaks: row.chain_breaks,
    };
  }
}
