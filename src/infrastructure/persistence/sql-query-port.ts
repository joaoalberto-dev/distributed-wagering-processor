import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  LedgerItemView,
  QueryPort,
  TransactionView,
  WalletView,
} from '../../application/ports/queries.js';
import type { FailureCode } from '../../domain/failure-code.js';
import type { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import type { WagerTransactionKind } from '../../domain/transaction/transaction-kind.js';
import type { WagerTransactionStatus } from '../../domain/transaction/transaction-status.js';
import type { ResultDetails } from '../../domain/transaction/wager-transaction.js';
import {
  type CallGuard,
  NO_OBSERVER,
  observeAndClassify,
  type PersistenceObserver,
  UNGUARDED,
} from './mikro-orm-unit-of-work.js';
import { query } from './repositories/sql.js';

type WalletRow = {
  id: string;
  player_id: string;
  balance: string;
  currency: string;
  version: number;
};

type LedgerRow = {
  id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date;
};

type TransactionRow = {
  id: string;
  provider_id: string | null;
  external_transaction_id: string | null;
  player_id: string;
  wallet_id: string;
  round_id: string | null;
  game_id: string | null;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  result_details: ResultDetails | null;
  result_balance_amount: string | null;
  result_balance_currency: string | null;
  attempts: number;
  created_at: Date;
  processed_at: Date | null;
};

const TRANSACTION_COLUMNS = `id, provider_id, external_transaction_id, player_id, wallet_id,
  round_id, game_id, kind, amount::text AS amount, currency::text AS currency,
  reference_external_transaction_id, reference_transaction_id, status, failure_code,
  result_details, result_balance_amount::text AS result_balance_amount,
  result_balance_currency::text AS result_balance_currency, attempts, created_at, processed_at`;

/**
 * The read side: each call is one short `READ ONLY` transaction with no row
 * locks, so a query never waits on a wallet that is being written.
 */
export class SqlQueryPort implements QueryPort {
  constructor(
    private readonly orm: MikroORM,
    /** The `postgres` circuit. */
    private readonly circuit: CallGuard = UNGUARDED,
    private readonly observer: PersistenceObserver = NO_OBSERVER,
  ) {}

  async wallet(id: string): Promise<WalletView | null> {
    const [row] = await this.read((em) =>
      query<WalletRow>(
        em,
        `SELECT id, player_id, balance::text AS balance, currency::text AS currency, version
           FROM wallets WHERE id = ?`,
        [id],
      ),
    );
    return row === undefined
      ? null
      : {
          id: row.id,
          playerId: row.player_id,
          balance: { amount: row.balance, currency: row.currency },
          version: row.version,
        };
  }

  async ledgerPage(
    walletId: string,
    afterVersion: number,
    limit: number,
  ): Promise<LedgerItemView[]> {
    const rows = await this.read((em) =>
      query<LedgerRow>(
        em,
        `SELECT id, transaction_id, direction, amount::text AS amount,
                currency::text AS currency, balance_before::text AS balance_before,
                balance_after::text AS balance_after, wallet_version, created_at
           FROM wallet_ledger_entries
          WHERE wallet_id = ? AND wallet_version > ?
          ORDER BY wallet_version
          LIMIT ?`,
        [walletId, afterVersion, limit],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      direction: row.direction,
      amount: { amount: row.amount, currency: row.currency },
      balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency },
      walletVersion: row.wallet_version,
      createdAt: new Date(row.created_at),
    }));
  }

  transaction(id: string): Promise<TransactionView | null> {
    return this.oneTransaction(
      `SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions WHERE id = ?`,
      [id],
    );
  }

  transactionByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<TransactionView | null> {
    return this.oneTransaction(
      `SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions
        WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalId],
    );
  }

  private async oneTransaction(
    sql: string,
    params: readonly unknown[],
  ): Promise<TransactionView | null> {
    const [row] = await this.read((em) =>
      query<TransactionRow>(em, sql, params),
    );
    return row === undefined ? null : toTransactionView(row);
  }

  private read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.circuit(async () => {
      try {
        return await this.orm.em
          .fork()
          .transactional((em) => fn(em), { readOnly: true });
      } catch (error) {
        throw observeAndClassify(error, this.observer);
      }
    });
  }
}

function toTransactionView(row: TransactionRow): TransactionView {
  const resultBalance =
    row.result_balance_amount === null || row.result_balance_currency === null
      ? null
      : {
          amount: row.result_balance_amount,
          currency: row.result_balance_currency,
        };
  return {
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: { amount: row.amount, currency: row.currency },
    referenceExternalTransactionId: row.reference_external_transaction_id,
    referenceTransactionId: row.reference_transaction_id,
    status: row.status,
    failureCode: row.failure_code,
    details: row.result_details,
    resultBalance,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at === null ? null : new Date(row.processed_at),
  };
}
