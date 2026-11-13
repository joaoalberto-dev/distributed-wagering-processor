import { expect, it } from 'bun:test';
import {
  openWallet,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { EventReader } from '../support/event-reader.js';
import { brl, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { waitFor } from '../support/wait-for.js';
import {
  CHANGED,
  expectLedger,
  expectWalletEvents,
  PROCESSED,
  REJECTED,
  walletOutbox,
} from '../support/wallet-evidence.js';

const infrastructure = useInfrastructure('historical-replay', {
  env: { DB_LOCK_TIMEOUT_MS: '7000' },
});
const database = useDatabase(infrastructure);
const cluster = useCluster(infrastructure);

it('replays historical results and serializes concurrent refunds across three processes', async () => {
  const [a, b, c] = [cluster.client(0), cluster.client(1), cluster.client(2)];
  expect(new Set(cluster.apps.map(({ pid }) => pid)).size).toBe(3);
  const wallet = await openWallet(a, '100.00');
  const bet = wagerBody(wallet, { money: brl('25.00') });
  const rejectedBet = wagerBody(wallet, { money: brl('90.00') });
  const original = await submit(a, bet);
  const rejected = await submit(a, rejectedBet);
  expect(original).toMatchObject({
    status: 200,
    body: {
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: false,
    },
  });
  expect(rejected).toMatchObject({
    status: 422,
    body: {
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('75.00'),
      idempotentReplay: false,
    },
  });
  const win = await submit(
    b,
    wagerBody(wallet, {
      kind: 'WIN',
      money: brl('10.00'),
      referenceExternalTransactionId: bet.externalTransactionId,
    }),
  );
  expect(win).toMatchObject({
    status: 200,
    body: { status: 'PROCESSED', balance: brl('85.00') },
  });

  const before = (await walletOutbox(database.app, [wallet.id])).map(
    ({ id }) => id,
  );
  for (const [body, response] of [
    [bet, original],
    [rejectedBet, rejected],
  ] as const) {
    const replay = await submit(c, body);
    expect(replay.status).toBe(response.status);
    expect(replay.body).toEqual({ ...response.body, idempotentReplay: true });
  }
  expect(
    (await walletOutbox(database.app, [wallet.id])).map(({ id }) => id),
  ).toEqual(before);
  await expectLedger(database.app, wallet.id, 3, '85.00');

  const refund = () =>
    wagerBody(wallet, {
      kind: 'REFUND',
      money: bet.money,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
  const { requests } = await database.owner.begin(async (holder) => {
    const [backend] = (await holder`SELECT pg_backend_pid() AS pid`) as {
      pid: number;
    }[];
    if (backend === undefined) throw new Error('Missing lock holder PID');
    await holder`SELECT id FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
    const requests = Promise.all([submit(a, refund()), submit(b, refund())]);
    // Walk indirect blockers as a row-lock waiter can queue behind another waiter.
    await waitFor(
      async () => {
        const [row] = (await database.owner`
        WITH RECURSIVE waiters(pid) AS (
          SELECT ${backend.pid}::int UNION
          SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
          WHERE a.datname = current_database()
        ) SELECT count(*)::int AS count FROM waiters`) as { count: number }[];
        return row?.count === 3;
      },
      {
        timeoutMs: 5000,
        description: 'both refund requests blocked by the held wallet lock',
      },
    );
    return { requests };
  });

  const [winner, loser] = (await requests).sort(
    (left, right) => left.status - right.status,
  );
  if (winner === undefined || loser === undefined)
    throw new Error('Both refunds must answer');
  expect(winner).toMatchObject({
    status: 200,
    body: {
      status: 'PROCESSED',
      balance: brl('110.00'),
      idempotentReplay: false,
    },
  });
  expect(loser).toMatchObject({
    status: 422,
    body: {
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      balance: brl('110.00'),
      idempotentReplay: false,
    },
  });
  expect(
    new Set(
      [original, rejected, win, winner, loser].map(
        ({ body }) => body.transactionId,
      ),
    ).size,
  ).toBe(5);
  expect(await walletOf(c, wallet.id)).toMatchObject({
    balance: brl('110.00'),
    version: 4,
  });
  const ledger = await expectLedger(database.app, wallet.id, 4, '110.00');
  expect(ledger.slice(1).map(({ transaction_id }) => transaction_id)).toEqual([
    original.body.transactionId,
    win.body.transactionId,
    winner.body.transactionId,
  ]);
  await expectReconciled(c, [wallet.id]);
  await expectWalletEvents(
    database.app,
    new EventReader(infrastructure),
    [wallet.id],
    [
      ...[original, win, winner].map(({ body }) => ({
        id: body.transactionId,
        types: [PROCESSED, CHANGED],
      })),
      ...[rejected, loser].map(({ body }) => ({
        id: body.transactionId,
        types: [REJECTED],
      })),
    ],
  );
});
