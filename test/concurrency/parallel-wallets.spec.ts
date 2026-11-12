/**
 * Scenario 3 (challenge §13): 30 wallets receive 20 bets each, all at once,
 * spread over three processes. Every bet is processed, every wallet ends at
 * the expected balance and version, and every wallet reconciles. SQS traffic
 * joins this scenario with the consumer (task 09).
 */
import { describe, expect, it } from 'bun:test';
import {
  openWallet,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { brl, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';

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
    const responses = await Promise.all(
      bets.map((bet, i) => submit(cluster.client(i), bet)),
    );

    const unexpected = responses.filter(
      (r) => r.status !== 200 || r.body.status !== 'PROCESSED',
    );
    expect(unexpected.map((r) => ({ status: r.status, body: r.body }))).toEqual(
      [],
    );
    expect(responses.every((r) => !r.body.idempotentReplay)).toBe(true);

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
