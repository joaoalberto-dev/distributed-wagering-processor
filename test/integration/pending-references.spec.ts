/**
 * The pending-reference worker against spawned processes (CUJ 3): the
 * wake-up, both TTL outcomes, coordination of two workers without a lease,
 * and a locked wallet that does not hold up other due rows.
 *
 * `short` stores pending rows with a 3 s TTL; `long` keeps the default TTL.
 * Both run the worker, and a TTL is stored with its row, so either one may
 * decide any row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Row, useDatabase } from '../support/database.js';
import {
  brl,
  keyOf,
  type MoneyBody,
  openWalletBody,
  type WagerBody,
  wagerBody,
} from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('pending-references');
const database = useDatabase(infrastructure);

let shortApp: SpawnedApp;
let longApp: SpawnedApp;
let short: HttpClient;
let long: HttpClient;
const opened: string[] = [];

beforeAll(async () => {
  [shortApp, longApp] = await Promise.all([
    spawnApp({ env: { ...infrastructure.env, REFERENCE_TTL_SECONDS: '3' } }),
    spawnApp({ env: infrastructure.env }),
  ]);
  short = new HttpClient(shortApp.baseUrl);
  long = new HttpClient(longApp.baseUrl);
});

afterAll(async () => {
  await expectReconciled(long, opened);
  await Promise.all([shortApp.stop(), longApp.stop()]);
});

type Wallet = { id: string; playerId: string; balance: MoneyBody };
type Result = { transactionId: string; status: string };
type Resource = {
  id: string;
  status: string;
  failureCode?: string;
  attempts: number;
};

async function open(amount = '100.00'): Promise<Wallet> {
  const response = await long.post<Wallet>(
    '/wallets',
    openWalletBody(brl(amount)),
  );
  expect(response.status).toBe(201);
  opened.push(response.body.id);
  return response.body;
}

async function send(
  client: HttpClient,
  body: WagerBody,
  expectedStatus: number,
): Promise<Result> {
  const response = await client.post<Result>('/wagering/transactions', body, {
    headers: keyOf(body),
  });
  expect({ status: response.status, body: response.body }).toMatchObject({
    status: expectedStatus,
  });
  return response.body;
}

/** A `REFUND` of `bet`, sent before it: answered 202. */
function refundBefore(
  client: HttpClient,
  wallet: Wallet,
  bet: WagerBody,
): Promise<Result> {
  return send(
    client,
    wagerBody(wallet, {
      kind: 'REFUND',
      money: bet.money,
      referenceExternalTransactionId: bet.externalTransactionId,
    }),
    202,
  );
}

async function read(id: string): Promise<Resource> {
  const response = await long.get<Resource>(`/wagering/transactions/${id}`);
  expect(response.status).toBe(200);
  return response.body;
}

function decided(id: string, timeoutMs: number): Promise<Resource> {
  return waitFor(
    async () => {
      const resource = await read(id);
      return resource.status === 'PENDING_REFERENCE' ? undefined : resource;
    },
    { timeoutMs, intervalMs: 50, description: `a decision on ${id}` },
  );
}

type Schedule = {
  attempts: number;
  next: Date;
  now: Date;
  status: string;
};

/** The row's schedule, read with the database clock. */
async function schedule(id: string): Promise<Schedule> {
  const [row] = (await database.owner`
    SELECT attempts, next_reference_attempt_at AS next,
           clock_timestamp() AS now, status
      FROM wager_transactions WHERE id = ${id}`) as Row[];
  if (row === undefined) throw new Error(`no transaction ${id}`);
  return row as Schedule;
}

describe('the wake-up', () => {
  it('processes a REFUND that came first within 2 s of its BET', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    const refund = await refundBefore(long, wallet, bet);

    // Let the backoff grow, so only the wake-up can make the row due in time.
    await waitFor(
      async () => {
        const row = await schedule(refund.transactionId);
        return row.next.getTime() - row.now.getTime() >= 3000;
      },
      {
        timeoutMs: 20_000,
        intervalMs: 50,
        description: 'a next attempt 3 s away',
      },
    );
    await send(long, bet, 200);
    const sentAt = Date.now();

    const resource = await decided(refund.transactionId, 2000);

    expect(Date.now() - sentAt).toBeLessThan(2000);
    expect(resource.status).toBe('PROCESSED');
    const balance = await long.get<Wallet>(`/wallets/${wallet.id}`);
    expect(balance.body.balance).toEqual(brl('100.00'));
  });
});

describe('at the TTL', () => {
  it('rejects a reference that never arrived as REFERENCE_NOT_FOUND', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    const refundBody = wagerBody(wallet, {
      kind: 'REFUND',
      money: bet.money,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const refund = await send(short, refundBody, 202);

    const resource = await decided(refund.transactionId, 10_000);

    expect(resource).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
    });
    // Final for this external ID: a replay answers the stored rejection.
    await send(short, refundBody, 422);
  });

  it('rejects a reference still pending as REFERENCE_NOT_READY', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    const refundBody = wagerBody(wallet, {
      kind: 'REFUND',
      money: bet.money,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const refund = await send(long, refundBody, 202);
    const rollback = await send(
      short,
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        money: refundBody.money,
        referenceExternalTransactionId: refundBody.externalTransactionId,
      }),
      202,
    );

    const resource = await decided(rollback.transactionId, 10_000);

    expect(resource).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_READY',
    });
    expect((await read(refund.transactionId)).status).toBe('PENDING_REFERENCE');
  });
});

describe('two workers', () => {
  it('count one attempt per backoff window on an absent reference', async () => {
    const wallet = await open();
    const refund = await refundBefore(long, wallet, wagerBody(wallet));

    const seen: Schedule[] = [await schedule(refund.transactionId)];
    const until = Date.now() + 7000;
    while (Date.now() < until) {
      const row = await schedule(refund.transactionId);
      const last = seen.at(-1);
      if (last !== undefined && row.attempts !== last.attempts) {
        expect({
          step: row.attempts - last.attempts,
          afterWindowOpened: row.now >= last.next,
        }).toEqual({ step: 1, afterWindowOpened: true });
        seen.push(row);
      }
      await Bun.sleep(10);
    }

    // 0.5–1 s, then 0.5–1, 1–2, and 2–4 s: at least three windows in 7 s.
    expect(seen.at(-1)?.attempts).toBeGreaterThanOrEqual(3);
  });
});

describe('a locked wallet', () => {
  it('does not stop five other due rows; its own row is pushed back uncounted', async () => {
    const locked = await open();
    const others = await Promise.all(Array.from({ length: 5 }, () => open()));
    const pairs = await Promise.all(
      others.map(async (wallet) => {
        const bet = wagerBody(wallet);
        return { bet, refund: await refundBefore(long, wallet, bet) };
      }),
    );
    const waiting = await refundBefore(long, locked, wagerBody(locked));

    await database.owner.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${locked.id} FOR UPDATE`;
      const before = await schedule(waiting.transactionId);

      await Promise.all(pairs.map(({ bet }) => send(long, bet, 200)));
      const results = await Promise.all(
        pairs.map(({ refund }) => decided(refund.transactionId, 5000)),
      );
      expect(results.map((r) => r.status)).toEqual(
        Array.from({ length: 5 }, () => 'PROCESSED'),
      );

      // Past its first due time, so a worker has met the lock.
      await waitFor(
        async () => {
          const row = await schedule(waiting.transactionId);
          return row.now.getTime() > before.next.getTime() + 1500;
        },
        { timeoutMs: 5000, description: 'the locked row to come due' },
      );
      const after = await schedule(waiting.transactionId);
      expect(after).toMatchObject({
        status: 'PENDING_REFERENCE',
        attempts: before.attempts,
      });
      expect(after.next.getTime()).toBeGreaterThan(before.next.getTime());
    });
  });
});
