/**
 * Scenario 7 (challenge §13) over HTTP on three processes: 20 reversals sent
 * before their bets all end `PROCESSED` once the bets arrive, each reversing
 * its own bet once, through the wake-up and the workers of every process.
 * SQS traffic is added in task 09.
 */
import { describe, expect, it } from 'bun:test';
import {
  ledgerDirections,
  openWallet,
  RETRY_UNAVAILABLE_MS,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { brl, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('out-of-order');
const cluster = useCluster(infrastructure);

const WALLETS = 5;
const BETS_PER_WALLET = 4;

type Resource = {
  id: string;
  status: string;
  referenceTransactionId?: string;
};

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

    const pending = await Promise.all(
      pairs.map(({ reversal }, i) => submit(cluster.client(i), reversal)),
    );
    expect(pending.map((r) => r.status)).toEqual(pairs.map(() => 202));

    // Each bet goes to another process than its reversal.
    const bets = await Promise.all(
      pairs.map(({ bet }, i) => submit(cluster.client(i + 1), bet)),
    );
    expect(bets.map((r) => r.status)).toEqual(pairs.map(() => 200));

    const decided = await Promise.all(
      pending.map(({ body }, i) =>
        waitFor(
          async () => {
            const response = await cluster
              .client(i + 2)
              .get<Resource>(`/wagering/transactions/${body.transactionId}`, {
                retryUnavailableMs: RETRY_UNAVAILABLE_MS,
              });
            return response.body.status === 'PENDING_REFERENCE'
              ? undefined
              : response.body;
          },
          {
            timeoutMs: 15_000,
            intervalMs: 100,
            description: `reversal ${body.transactionId}`,
          },
        ),
      ),
    );

    expect(decided.map((r) => r.status)).toEqual(pairs.map(() => 'PROCESSED'));
    expect(decided.map((r) => r.referenceTransactionId)).toEqual(
      bets.map((r) => r.body.transactionId),
    );
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
