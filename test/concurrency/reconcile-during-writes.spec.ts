/**
 * Reconciliation reads one consistent view of a wallet: 20 reconciliations
 * sent over three processes while 300 bets and wins are being written to
 * the same five wallets all answer `consistent: true` with no issues.
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
import {
  expectReconciled,
  type ReconciliationBody,
} from '../support/reconcile.js';

const infrastructure = useInfrastructure('reconcile-during-writes');
const cluster = useCluster(infrastructure);

const WALLETS = 5;
const WRITES = 300;
const RECONCILIATIONS = 20;
const IN_FLIGHT = 30;
/** Reconciliation `k` is sent once this many writes were answered. */
const sendAfter = (k: number) => 10 + 12 * k;

type Reconciled = {
  readonly walletId: string;
  readonly status: number;
  readonly consistent: boolean;
  readonly issues: ReconciliationBody['issues'];
  /** How many writes were answered when the reconciliation answered. */
  readonly writesAnswered: number;
};

describe('20 reconciliations during 300 concurrent writes', () => {
  it('all answer consistent', async () => {
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, (_, i) =>
        openWallet(cluster.client(i), '1000.00'),
      ),
    );
    // Each wallet alternates between groups of a 3.00 bet and a 2.00 win.
    const writes = Array.from({ length: WRITES }, (_, i) => {
      const wallet = wallets[i % WALLETS] as (typeof wallets)[number];
      return Math.floor(i / WALLETS) % 2 === 0
        ? wagerBody(wallet, { money: brl('3.00') })
        : wagerBody(wallet, { kind: 'WIN', money: brl('2.00') });
    });

    let answered = 0;
    let next = 0;
    const statuses: string[] = [];
    const reconciliations: Promise<Reconciled>[] = [];
    const reconcile = async (k: number): Promise<Reconciled> => {
      const walletId = (wallets[k % WALLETS] as (typeof wallets)[number]).id;
      const response = await cluster
        .client(k)
        .post<ReconciliationBody>(
          `/wallets/${walletId}/reconciliation`,
          undefined,
          { retryUnavailableMs: 10_000 },
        );
      return {
        walletId,
        status: response.status,
        consistent: response.body.consistent,
        issues: response.body.issues,
        writesAnswered: answered,
      };
    };
    const write = async (worker: number) => {
      while (next < writes.length) {
        const body = writes[next];
        next += 1;
        if (body === undefined) return;
        const response = await submit(cluster.client(worker), body);
        statuses.push(`${response.status} ${response.body.status}`);
        answered += 1;
        while (
          reconciliations.length < RECONCILIATIONS &&
          answered >= sendAfter(reconciliations.length)
        ) {
          reconciliations.push(reconcile(reconciliations.length));
        }
      }
    };
    await Promise.all(
      Array.from({ length: IN_FLIGHT }, (_, worker) => write(worker)),
    );
    const results = await Promise.all(reconciliations);

    expect(new Set(statuses)).toEqual(new Set(['200 PROCESSED']));
    expect(results).toHaveLength(RECONCILIATIONS);
    expect(
      results.filter(
        (r) => r.status !== 200 || !r.consistent || r.issues.length > 0,
      ),
    ).toEqual([]);
    // Each was sent while writes were still in flight (sendAfter < WRITES),
    // and most answered before the writes finished.
    expect(sendAfter(RECONCILIATIONS - 1)).toBeLessThan(WRITES);
    expect(
      results.filter((r) => r.writesAnswered < WRITES).length,
    ).toBeGreaterThan(RECONCILIATIONS / 2);

    // Every wallet: 30 bets of 3.00 and 30 wins of 2.00.
    for (const wallet of wallets) {
      const stored = await walletOf(cluster.client(0), wallet.id);
      expect({ balance: stored.balance, version: stored.version }).toEqual({
        balance: brl('970.00'),
        version: 1 + WRITES / WALLETS,
      });
    }
    await expectReconciled(
      cluster.client(0),
      wallets.map((w) => w.id),
    );
  });
});
