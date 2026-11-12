/**
 * Scenario 1 (challenge §13): one bet sent 50 times at once, spread over
 * three processes, debits once; every response carries the same transaction
 * and the same balance snapshot.
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

const infrastructure = useInfrastructure('duplicate-bet');
const cluster = useCluster(infrastructure);

const COPIES = 50;

describe('the same bet sent 50 times over 3 processes', () => {
  it('debits once and answers every copy with the same transaction and balance', async () => {
    const wallet = await openWallet(cluster.client(0), '100.00');
    const bet = wagerBody(wallet, { money: brl('25.00') });

    const responses = await Promise.all(
      Array.from({ length: COPIES }, (_, i) => submit(cluster.client(i), bet)),
    );

    expect(responses.map((r) => r.status)).toEqual(
      Array.from({ length: COPIES }, () => 200),
    );
    const first = responses.find((r) => !r.body.idempotentReplay);
    expect(first).toBeDefined();
    expect(responses.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    for (const response of responses) {
      expect(response.body).toEqual({
        ...first?.body,
        idempotentReplay: response !== first,
      } as typeof response.body);
    }
    expect(first?.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('75.00'),
    });

    expect((await walletOf(cluster.client(1), wallet.id)).balance).toEqual(
      brl('75.00'),
    );
    expect(await ledgerDirections(cluster.client(2), wallet.id)).toEqual([
      'CREDIT',
      'DEBIT',
    ]);
    await expectReconciled(cluster.client(0), [wallet.id]);
  });
});
