/**
 * Credits near the ceiling: 20 concurrent WINs of 100.00 on a wallet at
 * 999,999,999,000.00, over three processes. The 999.99 of headroom fits
 * nine of them; the other eleven are rejected with BALANCE_LIMIT_EXCEEDED,
 * and the balance never passes 999,999,999,999.99.
 */
import { describe, expect, it } from 'bun:test';
import {
  ledgerDirections,
  openWallet,
  submit,
  useCluster,
  walletOf,
} from '../support/cluster.js';
import { brl, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';

const infrastructure = useInfrastructure('ceiling-credits');
const cluster = useCluster(infrastructure);

const WINS = 20;
const FITTING = 9;
const CEILING_MINOR = 99_999_999_999_999n;

function minor(amount: string): bigint {
  return BigInt(amount.replace('.', ''));
}

describe('20 concurrent WINs of 100.00 next to the ceiling', () => {
  it('credits the nine that fit and rejects the rest with BALANCE_LIMIT_EXCEEDED', async () => {
    const wallet = await openWallet(cluster.client(0), '999999999000.00');

    const responses = await Promise.all(
      Array.from({ length: WINS }, (_, i) =>
        submit(
          cluster.client(i),
          wagerBody(wallet, { kind: 'WIN', money: brl('100.00') }),
        ),
      ),
    );

    const processed = responses.filter((r) => r.status === 200);
    const rejected = responses.filter((r) => r.status === 422);
    expect(processed).toHaveLength(FITTING);
    expect(rejected).toHaveLength(WINS - FITTING);
    for (const response of processed) {
      expect(response.body.status).toBe('PROCESSED');
    }
    for (const response of rejected) {
      expect(response.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'BALANCE_LIMIT_EXCEEDED',
      });
    }
    for (const response of responses) {
      const amount = response.body.balance?.amount ?? '';
      expect(minor(amount) <= CEILING_MINOR).toBe(true);
    }

    expect((await walletOf(cluster.client(1), wallet.id)).balance).toEqual(
      brl('999999999900.00'),
    );
    expect(await ledgerDirections(cluster.client(2), wallet.id)).toEqual(
      Array.from({ length: 1 + FITTING }, () => 'CREDIT'),
    );
    await expectReconciled(cluster.client(0), [wallet.id]);
  });
});
