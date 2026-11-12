/**
 * Scenario 7 (challenge §13) on three processes: 20 reversals sent before
 * their bets all end `PROCESSED` once the bets arrive, each reversing its own
 * bet once, through the wake-up and the workers of every process. Half of
 * the pairs send the reversal over SQS and the bet over HTTP; the other half
 * the other way round.
 */
import { describe, expect, it } from 'bun:test';
import {
  ledgerDirections,
  openWallet,
  storedOf,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { brl, type WagerBody, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';

const infrastructure = useInfrastructure('out-of-order');
const cluster = useCluster(infrastructure);

const WALLETS = 5;
const BETS_PER_WALLET = 4;

describe('20 reversals sent before their bets over 3 processes', () => {
  it('all end PROCESSED, each reversing its own bet once', async () => {
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, (_, i) =>
        openWallet(cluster.client(i), '100.00'),
      ),
    );
    const pairs = wallets.flatMap((wallet) =>
      Array.from({ length: BETS_PER_WALLET }, (_, i) => {
        const bet = wagerBody(wallet, { money: brl('25.00') });
        const reversal = wagerBody(wallet, {
          kind: i % 2 === 0 ? 'REFUND' : 'ROLLBACK',
          money: bet.money,
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        return { bet, reversal };
      }),
    );

    const queues = new TestQueues(infrastructure);
    const overSqs = (i: number) => i % 2 === 1;
    /** Sends `body` over SQS or HTTP; an HTTP answer must have `status`. */
    const send = async (body: WagerBody, i: number, status: number) => {
      if (overSqs(i)) {
        await queues.send(envelopeOf(body));
        return;
      }
      const response = await submit(cluster.client(i), body);
      expect({ status: response.status, body: response.body }).toMatchObject({
        status,
      });
    };

    // Every reversal is stored as pending before any bet is sent.
    await Promise.all(pairs.map(({ reversal }, i) => send(reversal, i, 202)));
    const pending = await Promise.all(
      pairs.map(({ reversal }, i) =>
        storedOf(cluster.client(i + 1), reversal, () => true),
      ),
    );
    expect(pending.map((r) => r.status)).toEqual(
      pairs.map(() => 'PENDING_REFERENCE'),
    );

    // Each bet goes over the other channel than its reversal.
    await Promise.all(pairs.map(({ bet }, i) => send(bet, i + 1, 200)));
    const bets = await Promise.all(
      pairs.map(({ bet }, i) => storedOf(cluster.client(i), bet)),
    );
    expect(bets.map((r) => r.status)).toEqual(pairs.map(() => 'PROCESSED'));

    const decided = await Promise.all(
      pairs.map(({ reversal }, i) =>
        storedOf(cluster.client(i + 2), reversal, undefined, 15_000),
      ),
    );

    expect(decided.map((r) => r.status)).toEqual(pairs.map(() => 'PROCESSED'));
    expect(decided.map((r) => r.referenceTransactionId)).toEqual(
      bets.map((r) => r.id),
    );
    await queues.drained();
    expect(await queues.deadLetters()).toEqual([]);
    for (const [i, wallet] of wallets.entries()) {
      expect((await walletOf(cluster.client(i), wallet.id)).balance).toEqual(
        brl('100.00'),
      );
      const directions = await ledgerDirections(cluster.client(i), wallet.id);
      expect(directions.filter((d) => d === 'DEBIT')).toHaveLength(
        BETS_PER_WALLET,
      );
      expect(directions.filter((d) => d === 'CREDIT')).toHaveLength(
        BETS_PER_WALLET + 1,
      );
    }
    await expectReconciled(
      cluster.client(0),
      wallets.map((w) => w.id),
    );
  });
});
