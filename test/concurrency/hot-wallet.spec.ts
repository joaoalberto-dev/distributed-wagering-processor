/**
 * A hot wallet next to quiet ones: 200 bets hit one wallet at once over three
 * processes while 10 other wallets receive one bet each. The bulkhead is
 * shrunk so the burst overflows it deterministically. The burst's excess is
 * shed with 503 and nothing is stored for it; the quiet wallets' bets, one
 * over HTTP and one over SQS each, still complete; the postgres circuit
 * stays closed, because contention is not an outage. Publisher assertions
 * join with task 10.
 */
import { describe, expect, it } from 'bun:test';
import {
  ledgerDirections,
  metricValue,
  openWallet,
  storedOf,
  submit,
  useCluster,
  type WagerResult,
  walletOf,
} from '../support/cluster.js';
import { brl, keyOf, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';

const infrastructure = useInfrastructure('hot-wallet');
const cluster = useCluster(infrastructure, {
  env: { HTTP_BULKHEAD_SIZE: '4', HTTP_BULKHEAD_QUEUE: '4' },
});

const BURST = 200;
const QUIET_WALLETS = 10;

function centsToAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

describe('200 concurrent bets on one wallet beside 10 quiet wallets', () => {
  it('sheds the excess with 503, completes the quiet bets, and keeps the circuit closed', async () => {
    const hot = await openWallet(cluster.client(0), '500.00');
    const quiet = await Promise.all(
      Array.from({ length: QUIET_WALLETS }, (_, i) =>
        openWallet(cluster.client(i), '100.00'),
      ),
    );

    // The burst is sent once, without resending 503s, to observe shedding.
    const burst = Array.from({ length: BURST }, (_, i) => {
      const body = wagerBody(hot, { money: brl('1.00') });
      return cluster
        .client(i)
        .post<WagerResult>('/wagering/transactions', body, {
          headers: keyOf(body),
        });
    });
    const quietBets = quiet.map((wallet, i) =>
      submit(cluster.client(i), wagerBody(wallet)),
    );
    const queues = new TestQueues(infrastructure);
    const quietSqsBets = quiet.map((wallet) => wagerBody(wallet));
    const [hotResponses, quietResponses] = await Promise.all([
      Promise.all(burst),
      Promise.all(quietBets),
      Promise.all(quietSqsBets.map((bet) => queues.send(envelopeOf(bet)))),
    ]);

    for (const response of quietResponses) {
      expect({ status: response.status, body: response.body }).toMatchObject({
        status: 200,
        body: { status: 'PROCESSED' },
      });
    }
    for (const [i, bet] of quietSqsBets.entries()) {
      expect((await storedOf(cluster.client(i), bet)).status).toBe('PROCESSED');
    }
    for (const [i, wallet] of quiet.entries()) {
      expect((await walletOf(cluster.client(i), wallet.id)).balance).toEqual(
        brl('50.00'),
      );
    }
    await queues.drained();
    expect(await queues.deadLetters()).toEqual([]);

    const statuses = new Set(hotResponses.map((r) => r.status));
    expect([...statuses].filter((s) => s !== 200 && s !== 503)).toEqual([]);
    const shed = hotResponses.filter((r) => r.status === 503);
    const processed = hotResponses.filter((r) => r.status === 200);
    expect(shed.length).toBeGreaterThan(0);
    expect(processed.length).toBeGreaterThan(0);
    for (const response of shed) {
      expect(response.headers.get('retry-after')).toBe('1');
    }
    for (const response of processed) {
      expect(response.body.status).toBe('PROCESSED');
    }

    let rejections = 0;
    for (const client of cluster.clients) {
      rejections += await metricValue(
        client,
        'bulkhead_rejections_total{group="http"}',
      );
      expect(
        await metricValue(client, 'circuit_state{dependency="postgres"}'),
      ).toBe(0);
    }
    expect(rejections).toBeGreaterThan(0);

    const expected = centsToAmount(50_000 - processed.length * 100);
    expect((await walletOf(cluster.client(1), hot.id)).balance).toEqual(
      brl(expected),
    );
    expect(await ledgerDirections(cluster.client(2), hot.id)).toHaveLength(
      1 + processed.length,
    );
    await expectReconciled(cluster.client(0), [
      hot.id,
      ...quiet.map((w) => w.id),
    ]);
  });
});
