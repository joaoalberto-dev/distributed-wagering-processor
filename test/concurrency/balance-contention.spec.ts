/**
 * Scenario 2 (challenge §8): two bets of 80.00 on a wallet of 100.00, sent
 * at the same time to two different processes. Exactly one is processed,
 * the other is rejected with INSUFFICIENT_FUNDS, and the wallet ends at
 * 20.00 with a single debit. Repeated on several wallets at once so each
 * run exercises the race more than once.
 */
import { describe, expect, it } from 'bun:test';
import {
  ledgerDirections,
  openWallet,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, wagerBody } from '../support/factories.js';
import { EventReader } from '../support/event-reader.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';

import {
  CHANGED,
  expectLedger,
  expectWalletEvents,
  PROCESSED,
  REJECTED,
} from '../support/wallet-evidence.js';

const infrastructure = useInfrastructure('balance-contention');
const database = useDatabase(infrastructure);
const cluster = useCluster(infrastructure);

const ROUNDS = 10;

async function contend(round: number) {
  const wallet = await openWallet(cluster.client(round), '100.00');
  const a = wagerBody(wallet, { money: brl('80.00') });
  const b = wagerBody(wallet, { money: brl('80.00') });

  const responses = await Promise.all([
    submit(cluster.client(round), a),
    submit(cluster.client(round + 1), b),
  ]);

  const outcomes = responses
    .map((r) => ({
      status: r.status,
      result: r.body.status,
      failureCode: r.body.failureCode,
      balance: r.body.balance,
    }))
    .sort((x, y) => x.status - y.status);
  expect(outcomes).toEqual([
    {
      status: 200,
      result: 'PROCESSED',
      failureCode: undefined,
      balance: brl('20.00'),
    },
    {
      status: 422,
      result: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('20.00'),
    },
  ]);

  expect(
    (await walletOf(cluster.client(round + 2), wallet.id)).balance,
  ).toEqual(brl('20.00'));
  expect(await ledgerDirections(cluster.client(round), wallet.id)).toEqual([
    'CREDIT',
    'DEBIT',
  ]);
  await expectLedger(database.app, wallet.id, 2, '20.00');
  return {
    walletId: wallet.id,
    expected: responses.map(({ status, body }) => ({
      id: body.transactionId,
      types: status === 200 ? [PROCESSED, CHANGED] : [REJECTED],
    })),
  };
}

describe('two 80.00 bets on a 100.00 wallet through two processes', () => {
  it('processes one, rejects the other with INSUFFICIENT_FUNDS, and leaves 20.00', async () => {
    const wallets = await Promise.all(
      Array.from({ length: ROUNDS }, (_, round) => contend(round)),
    );
    const ids = wallets.map(({ walletId }) => walletId);
    await expectWalletEvents(
      database.app,
      new EventReader(infrastructure),
      ids,
      wallets.flatMap(({ expected }) => expected),
    );
    await expectReconciled(cluster.client(0), ids);
  });
});
