/**
 * The migrations run up, down, and up again on a scratch database, and the
 * last applied migration is `LATEST_MIGRATION`, which readiness checks.
 */
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { LATEST_MIGRATION, migrations } from '../../migrations/index.js';
import { migrate } from '../../scripts/migrate.js';
import { useInfrastructure } from '../support/infrastructure.js';

const infrastructure = useInfrastructure('migrations');

const SCRATCH = `wagering_migrations_${Math.random().toString(36).slice(2, 8)}`;
const TABLES = [
  'inbox',
  'outbox',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

let server: SQL;
let scratch: SQL;
let scratchUrl: string;

beforeAll(async () => {
  const ownerUrl = infrastructure.config.database.ownerUrl;
  server = new SQL(withDatabase(ownerUrl, 'postgres'), { max: 1 });
  await server.unsafe(`CREATE DATABASE ${SCRATCH}`);
  scratchUrl = withDatabase(ownerUrl, SCRATCH);
  scratch = new SQL(scratchUrl, { max: 1 });
});

afterAll(async () => {
  await scratch.close();
  await server.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await server.close();
});

async function tables(): Promise<string[]> {
  const rows: { table_name: string }[] = await scratch`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'
    ORDER BY table_name`;
  return rows.map((row) => row.table_name);
}

async function routines(): Promise<string[]> {
  const rows: { routine_name: string }[] = await scratch`
    SELECT routine_name FROM information_schema.routines
    WHERE routine_schema = 'public' ORDER BY routine_name`;
  return rows.map((row) => row.routine_name);
}

describe('migrations', () => {
  const names = migrations.map((migration) => migration.name);

  it('lists the seven migrations in order, the last one being LATEST_MIGRATION', () => {
    expect(names).toEqual([
      'Migration0001Wallets',
      'Migration0002WagerTransactions',
      'Migration0003WalletLedgerEntries',
      'Migration0004InboxOutbox',
      'Migration0005CommitConsistency',
      'Migration0006WorkerIndexes',
      'Migration0007RejectionSnapshotCurrency',
    ]);
    expect(names.at(-1)).toBe(LATEST_MIGRATION);
  });

  it('runs up, down, and up again', async () => {
    expect(await migrate('up', scratchUrl)).toEqual(names);
    expect(await tables()).toEqual(TABLES);

    expect(await migrate('down', scratchUrl, { all: true })).toEqual(
      names.toReversed(),
    );
    expect(await tables()).toEqual([]);
    expect(await routines()).toEqual([]);

    expect(await migrate('up', scratchUrl)).toEqual(names);
    expect(await tables()).toEqual(TABLES);
    expect(await migrate('up', scratchUrl)).toEqual([]);
  });

  it('records LATEST_MIGRATION as the last applied migration', async () => {
    const rows: { name: string }[] = await scratch`
      SELECT name FROM mikro_orm_migrations ORDER BY id DESC LIMIT 1`;
    expect(rows.map((row) => row.name)).toEqual([LATEST_MIGRATION]);
  });
});
