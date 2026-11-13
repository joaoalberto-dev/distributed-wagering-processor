import type { SQL } from 'bun';
import { expect } from 'bun:test';
import type { EventReader, PublishedEvent } from './event-reader.js';

export const PROCESSED = 'WagerTransactionProcessed';
export const CHANGED = 'WalletBalanceChanged';
export const REJECTED = 'WagerTransactionRejected';
export const PENDING = 'WagerTransactionPendingReference';

export type TransactionEvents = {
  readonly id: string;
  readonly types: readonly string[];
  readonly optionalPending?: boolean;
};

export async function walletOutbox(sql: SQL, walletIds: readonly string[]) {
  return (await sql`
    SELECT id, wallet_id, event_type, payload, published_at IS NOT NULL AS published
    FROM outbox WHERE wallet_id IN ${sql(walletIds)} ORDER BY id
  `) as {
    id: string;
    wallet_id: string;
    event_type: string;
    payload: PublishedEvent;
    published: boolean;
  }[];
}

export async function expectWalletEvents(
  sql: SQL,
  reader: EventReader,
  walletIds: readonly string[],
  expected: readonly TransactionEvents[],
) {
  const openings = (await sql`
    SELECT id FROM wager_transactions WHERE wallet_id IN ${sql(walletIds)} AND kind = 'OPENING'
  `) as { id: string }[];
  expect(openings).toHaveLength(walletIds.length);
  const rows = await walletOutbox(sql, walletIds);
  const byTransaction = new Map<string, string[]>();
  for (const row of rows) {
    const id = row.payload.data.transactionId;
    if (typeof id !== 'string')
      throw new Error(`Event ${row.id} has no transaction ID`);
    const types = byTransaction.get(id) ?? [];
    types.push(row.event_type);
    byTransaction.set(id, types);
  }
  const operations = [
    ...expected,
    ...openings.map(({ id }): TransactionEvents => ({
      id,
      types: [PROCESSED, CHANGED],
    })),
  ];
  expect([...byTransaction.keys()].sort()).toEqual(
    operations.map(({ id }) => id).sort(),
  );
  for (const { id, types, optionalPending } of operations) {
    const actual = byTransaction.get(id) ?? [];
    const wanted =
      optionalPending && actual.includes(PENDING) ? [...types, PENDING] : types;
    expect({ id, types: actual.toSorted() }).toEqual({
      id,
      types: wanted.toSorted(),
    });
  }
  await reader.waitForIds(rows.map(({ id }) => id));
  // Read once more after the expected IDs so duplicate deliveries are checked too.
  await reader.poll();
  const actual = reader
    .events()
    .filter(({ event }) => walletIds.includes(String(event.data.walletId)))
    .map(({ event, groupId }) => ({ event, groupId }))
    .toSorted((a, b) => a.event.eventId.localeCompare(b.event.eventId));
  expect(actual).toEqual(
    rows.map(({ payload, wallet_id }) => ({
      event: payload,
      groupId: wallet_id,
    })),
  );
  expect(
    (await walletOutbox(sql, walletIds)).every(({ published }) => published),
  ).toBe(true);
}

function minorUnits(amount: string): bigint {
  if (!/^\d+\.\d{2}$/.test(amount))
    throw new Error(`Invalid ledger amount ${amount}`);
  return BigInt(amount.replace('.', ''));
}

export async function expectLedger(
  sql: SQL,
  walletId: string,
  entries: number,
  amount: string,
) {
  const rows = (await sql`
    SELECT transaction_id, direction, amount::text, balance_before::text,
      balance_after::text, wallet_version
    FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY wallet_version
  `) as {
    transaction_id: string;
    direction: string;
    amount: string;
    balance_before: string;
    balance_after: string;
    wallet_version: number;
  }[];
  expect(rows).toHaveLength(entries);
  expect(new Set(rows.map(({ transaction_id }) => transaction_id)).size).toBe(
    entries,
  );
  let balance = 0n;
  for (const [index, row] of rows.entries()) {
    expect(row.wallet_version).toBe(index + 1);
    expect(minorUnits(row.balance_before)).toBe(balance);
    expect(['DEBIT', 'CREDIT']).toContain(row.direction);
    const delta = minorUnits(row.amount);
    balance += row.direction === 'CREDIT' ? delta : -delta;
    expect(balance).toBeGreaterThanOrEqual(0n);
    expect(minorUnits(row.balance_after)).toBe(balance);
  }
  expect(balance).toBe(minorUnits(amount));
  return rows;
}
