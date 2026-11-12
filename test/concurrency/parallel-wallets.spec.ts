/**
 * Scenario 3 (challenge §13): 30 wallets receive 20 bets each, all at once,
 * spread over three processes, half over HTTP and half over SQS. Every bet
 * is processed, every wallet ends at the expected balance and version, and
 * every wallet reconciles.
 */
import { describe, expect, it } from 'bun:test';
import {
  metricValue,
  openWallet,
  storedOf,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { brl, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';

const infrastructure = useInfrastructure('parallel-wallets');
const cluster = useCluster(infrastructure);

const WALLETS = 30;
const BETS_PER_WALLET = 20;

describe('30 wallets × 20 bets over 3 processes', () => {
  it('processes every bet and keeps every wallet consistent', async () => {
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, (_, i) =>
        openWallet(cluster.client(i), '1000.00'),
      ),
    );

    const bets = wallets.flatMap((wallet) =>
      Array.from({ length: BETS_PER_WALLET }, () =>
        wagerBody(wallet, { money: brl('10.00') }),
      ),
    );
    // Even bets over HTTP, odd bets over SQS, all sent at once.
    const queues = new TestQueues(infrastructure);
    const overHttp = bets.filter((_, i) => i % 2 === 0);
    const overSqs = bets.filter((_, i) => i % 2 === 1);
    const [responses] = await Promise.all([
      Promise.all(overHttp.map((bet, i) => submit(cluster.client(i), bet))),
      Promise.all(overSqs.map((bet) => queues.send(envelopeOf(bet)))),
    ]);

    const unexpected = responses.filter(
      (r) => r.status !== 200 || r.body.status !== 'PROCESSED',
    );
    expect(unexpected.map((r) => ({ status: r.status, body: r.body }))).toEqual(
      [],
    );
    expect(responses.every((r) => !r.body.idempotentReplay)).toBe(true);

    for (const [i, bet] of overSqs.entries()) {
      expect((await storedOf(cluster.client(i), bet)).status).toBe('PROCESSED');
    }
    await queues.drained();
    expect(await queues.deadLetters()).toEqual([]);
    let consumed = 0;
    for (const client of cluster.clients) {
      consumed += await metricValue(
        client,
        'wager_transactions_total{kind="BET",status="PROCESSED",channel="sqs"}',
      );
    }
    expect(consumed).toBe(overSqs.length);

    for (const [i, wallet] of wallets.entries()) {
      const current = await walletOf(cluster.client(i), wallet.id);
      expect({
        id: current.id,
        balance: current.balance,
        version: current.version,
      }).toEqual({
        id: wallet.id,
        balance: brl('800.00'),
        version: 1 + BETS_PER_WALLET,
      });
    }
    await expectReconciled(
      cluster.client(0),
      wallets.map((w) => w.id),
    );
  });
});
