import { SQL } from 'bun';
import { afterAll, beforeAll } from 'bun:test';
import type { Infrastructure } from './infrastructure.js';

export type Row = Record<string, unknown>;

/** Direct SQL connections to the test database: as the app role and as the owner. */
export type Database = {
  /** `wagering_app`: what the application can do, and nothing more. */
  readonly app: SQL;
  /** `wagering_owner`: for fixtures and checks the app role is not allowed to run. */
  readonly owner: SQL;
};

/** Opens both connections before the spec's tests and closes them after. */
export function useDatabase(infrastructure: Infrastructure): Database {
  let app: SQL | undefined;
  let owner: SQL | undefined;
  beforeAll(() => {
    app = new SQL(infrastructure.config.database.url, { max: 4 });
    owner = new SQL(infrastructure.config.database.ownerUrl, { max: 2 });
  });
  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });
  const ready = (sql: SQL | undefined): SQL => {
    if (sql === undefined) throw new Error('Database is used before beforeAll');
    return sql;
  };
  return {
    get app() {
      return ready(app);
    },
    get owner() {
      return ready(owner);
    },
  };
}

/**
 * Marks every unpublished event as published. Events that earlier specs or
 * runs left behind would otherwise be published into whichever spec runs a
 * publisher next, ahead of its own; nobody reads them. Run as the owner.
 */
export async function settlePendingEvents(sql: SQL): Promise<void> {
  await sql`UPDATE outbox SET published_at = now() WHERE published_at IS NULL`;
}

export function newId(): string {
  return Bun.randomUUIDv7();
}

export async function insertRow(
  sql: SQL,
  table: string,
  row: Row,
): Promise<void> {
  await sql`INSERT INTO ${sql(table)} ${sql(row)}`;
}

/** A `wallets` row at zero, version 1: consistent without any ledger entry. */
export function walletRow(overrides: Row = {}): Row {
  return {
    id: newId(),
    player_id: newId(),
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    ...overrides,
  };
}

/** A `PROCESSED` provider `BET` of 25.00 with its result snapshot, for `wallet`. */
export function transactionRow(wallet: Row, overrides: Row = {}): Row {
  const external = `ext-${newId()}`;
  return {
    id: newId(),
    provider_id: 'provider-test',
    external_transaction_id: external,
    idempotency_key: `key-${external}`,
    payload_hash: 'v1:test',
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '25.00',
    currency: wallet.currency,
    status: 'PROCESSED',
    result_balance_amount: '75.00',
    result_balance_currency: wallet.currency,
    correlation_id: 'correlation-test',
    processed_at: new Date(),
    ...overrides,
  };
}

/** A `PENDING_REFERENCE` `REFUND` of 25.00 waiting for an external ID that never arrives. */
export function pendingRow(wallet: Row, overrides: Row = {}): Row {
  return transactionRow(wallet, {
    kind: 'REFUND',
    reference_external_transaction_id: `missing-${newId()}`,
    status: 'PENDING_REFERENCE',
    result_balance_amount: null,
    result_balance_currency: null,
    processed_at: null,
    next_reference_attempt_at: new Date(),
    reference_expires_at: new Date(Date.now() + 86_400_000),
    ...overrides,
  });
}

/** A ledger entry of `transaction`, by default the debit 100.00 → 75.00 at version 2. */
export function entryRow(transaction: Row, overrides: Row = {}): Row {
  return {
    id: newId(),
    wallet_id: transaction.wallet_id,
    transaction_id: transaction.id,
    direction: 'DEBIT',
    amount: transaction.amount,
    currency: transaction.currency,
    balance_before: '100.00',
    balance_after: '75.00',
    wallet_version: 2,
    ...overrides,
  };
}

export type OpenedWallet = { readonly wallet: Row; readonly opening: Row };

/** Commits a wallet opened with `balance` (> 0): the wallet, its `OPENING` credit, and entry 1. */
export async function openWallet(
  sql: SQL,
  balance = '100.00',
): Promise<OpenedWallet> {
  const wallet = walletRow({ balance });
  const opening = transactionRow(wallet, {
    provider_id: null,
    external_transaction_id: null,
    idempotency_key: null,
    payload_hash: null,
    round_id: null,
    game_id: null,
    kind: 'OPENING',
    amount: balance,
    result_balance_amount: balance,
  });
  await sql.begin(async (tx) => {
    await insertRow(tx, 'wallets', wallet);
    await insertRow(tx, 'wager_transactions', opening);
    await insertRow(
      tx,
      'wallet_ledger_entries',
      entryRow(opening, {
        direction: 'CREDIT',
        balance_before: '0.00',
        balance_after: balance,
        wallet_version: 1,
      }),
    );
  });
  return { wallet, opening };
}

/** The SQLSTATE and constraint (or trigger) name of a PostgreSQL error from Bun SQL. */
export type Violation = {
  readonly sqlState: string;
  readonly constraint: string | undefined;
};

function asViolation(error: unknown): Violation {
  const fields = error as { errno?: unknown; constraint?: unknown };
  if (typeof fields.errno !== 'string') throw error;
  return {
    sqlState: fields.errno,
    constraint:
      typeof fields.constraint === 'string' ? fields.constraint : undefined,
  };
}

/** Thrown to roll a fixture transaction back on purpose. */
export class Rollback extends Error {}

/**
 * Runs `statements` in a transaction that is always rolled back, so deferred
 * triggers never fire, and returns the violation one of them raised.
 */
export async function violationOf(
  sql: SQL,
  statements: (tx: SQL) => Promise<unknown>,
): Promise<Violation> {
  try {
    await sql.begin(async (tx) => {
      await statements(tx);
      throw new Rollback('rolled back on purpose');
    });
  } catch (error) {
    if (error instanceof Rollback)
      throw new Error('Expected a violation, but every statement succeeded');
    return asViolation(error);
  }
  throw new Error('unreachable');
}

/** Runs `statements` in a transaction that commits, and returns the violation raised at `COMMIT`. */
export async function commitViolationOf(
  sql: SQL,
  statements: (tx: SQL) => Promise<unknown>,
): Promise<Violation> {
  try {
    await sql.begin(async (tx) => {
      await statements(tx);
    });
  } catch (error) {
    return asViolation(error);
  }
  throw new Error('Expected the commit to fail, but it succeeded');
}

function addCents(amount: string, cents: bigint): string {
  const minor = BigInt(amount.replace('.', '')) + cents;
  const digits = minor.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Commits `count` processed `WIN` credits of 1.00 on a committed wallet, one
 * SQL transaction each, so every commit-time check passes. For specs that
 * need ledger entries before the wagering endpoint exists.
 */
export async function appendWins(
  sql: SQL,
  walletId: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await sql.begin(async (tx) => {
      const [wallet] = (await tx`
        SELECT id, player_id, currency, balance::text AS balance, version
          FROM wallets WHERE id = ${walletId} FOR UPDATE`) as Row[];
      if (wallet === undefined) throw new Error(`no wallet ${walletId}`);
      const before = String(wallet.balance);
      const after = addCents(before, 100n);
      const version = Number(wallet.version) + 1;
      const win = transactionRow(wallet, {
        kind: 'WIN',
        amount: '1.00',
        result_balance_amount: after,
      });
      await insertRow(tx, 'wager_transactions', win);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(win, {
          direction: 'CREDIT',
          balance_before: before,
          balance_after: after,
          wallet_version: version,
        }),
      );
      await tx`UPDATE wallets SET balance = ${after}, version = ${version},
                 updated_at = now() WHERE id = ${walletId}`;
    });
  }
}
