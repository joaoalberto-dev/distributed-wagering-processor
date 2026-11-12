/**
 * Scenario 8 (challenge §13): three processes under 500 mixed operations,
 * half over HTTP and half over SQS, are all killed with `SIGKILL` part way
 * through. Three new processes start, the provider resends every HTTP
 * operation it got no answer for (with the same key), and the rest of the
 * traffic follows. Within 60 s of the restart no work is left behind: no
 * pending reference, no unpublished outbox row, an empty input queue with
 * nothing in flight, and an empty DLQ. Every operation is processed once,
 * and every wallet ends at the expected balance and version and reconciles.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  openWallet,
  submit,
  type Wallet,
  walletOf,
} from '../support/cluster.js';
import { settlePendingEvents, useDatabase } from '../support/database.js';
import { brl, keyOf, type WagerBody, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

const WALLETS = 10;
const GROUPS_PER_WALLET = 10;
/** Five operations per group: 10 wallets × 10 groups × 5 = 500. */
const OPERATIONS = WALLETS * GROUPS_PER_WALLET * 5;
/** The first processes are killed once this many operations were answered. */
const KILL_AFTER = 200;
const IN_FLIGHT = 40;
const RECOVERY_MS = 60_000;

const infrastructure = useInfrastructure('restart-recovery', {
  env: { SQS_VISIBILITY_TIMEOUT_SECONDS: '5' },
});
const database = useDatabase(infrastructure);

const apps: SpawnedApp[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.stop()));
});

async function startProcesses(): Promise<HttpClient[]> {
  const started = await Promise.all(
    Array.from({ length: 3 }, () => spawnApp({ env: infrastructure.env })),
  );
  apps.push(...started);
  return started.map((app) => new HttpClient(app.baseUrl));
}

type Operation = { readonly body: WagerBody; readonly overSqs: boolean };

/**
 * One group on `wallet`: a bet that is won, a bet that is refunded, and a
 * rollback of the win (even groups) or a loss on the first bet (odd groups).
 * Two groups in three send the dependents before what they reference, so
 * reversals and settlements wait as pending references.
 *
 * Effect: even groups −5.00 with 5 entries; odd groups +2.00 with 4 entries.
 */
function groupOf(wallet: Wallet, group: number): WagerBody[] {
  const won = wagerBody(wallet, { money: brl('5.00') });
  const win = wagerBody(wallet, {
    kind: 'WIN',
    money: brl('7.00'),
    referenceExternalTransactionId: won.externalTransactionId,
  });
  const refunded = wagerBody(wallet, { money: brl('4.00') });
  const refund = wagerBody(wallet, {
    kind: 'REFUND',
    money: brl('4.00'),
    referenceExternalTransactionId: refunded.externalTransactionId,
  });
  const last =
    group % 2 === 0
      ? wagerBody(wallet, {
          kind: 'ROLLBACK',
          money: brl('7.00'),
          referenceExternalTransactionId: win.externalTransactionId,
        })
      : wagerBody(wallet, {
          kind: 'LOSS',
          money: brl('5.00'),
          referenceExternalTransactionId: won.externalTransactionId,
        });
  return group % 3 === 0
    ? [won, win, refunded, refund, last]
    : [refund, last, win, refunded, won];
}

const EXPECTED_BALANCE = brl('985.00');
/** The opening entry, then 5 even groups of 5 entries and 5 odd groups of 4. */
const EXPECTED_VERSION = 1 + 5 * 5 + 5 * 4;

describe('3 processes killed under 500 mixed operations, then 3 new ones', () => {
  it('leaves no pending work within 60 s, and every wallet reconciles', async () => {
    await settlePendingEvents(database.owner);
    const queues = new TestQueues(infrastructure);
    const first = await startProcesses();
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, (_, i) =>
        openWallet(first[i % 3] as HttpClient, '1000.00'),
      ),
    );
    const walletIds = wallets.map((wallet) => wallet.id);
    const operations: Operation[] = Array.from(
      { length: GROUPS_PER_WALLET },
      (_, group) => wallets.flatMap((wallet) => groupOf(wallet, group)),
    )
      .flat()
      .map((body, i) => ({ body, overSqs: i % 2 === 1 }));
    expect(operations).toHaveLength(OPERATIONS);

    // Phase 1: send until KILL_AFTER answers, then kill every process. An
    // HTTP request that gets a 503 or loses its connection is resent later.
    const unanswered: Operation[] = [];
    const unexpected: unknown[] = [];
    let next = 0;
    let answered = 0;
    let killed: Promise<unknown> | undefined;
    const killAll = () => {
      killed ??= Promise.all(
        apps.slice(0, 3).map((app) => app.stop('SIGKILL')),
      );
    };
    const sendUntilKilled = async (worker: number) => {
      while (killed === undefined && next < operations.length) {
        const operation = operations[next] as Operation;
        next += 1;
        if (operation.overSqs) {
          await queues.send(envelopeOf(operation.body));
          answered += 1;
        } else {
          try {
            const response = await (first[worker % 3] as HttpClient).post(
              '/wagering/transactions',
              operation.body,
              { headers: keyOf(operation.body) },
            );
            if (response.status === 503) unanswered.push(operation);
            else if (response.status === 200 || response.status === 202)
              answered += 1;
            else
              unexpected.push({ status: response.status, body: response.body });
          } catch {
            unanswered.push(operation);
          }
        }
        if (answered >= KILL_AFTER) killAll();
      }
    };
    await Promise.all(
      Array.from({ length: IN_FLIGHT }, (_, worker) => sendUntilKilled(worker)),
    );
    await killed;
    expect(unexpected).toEqual([]);
    // The kill interrupted HTTP requests in flight, not an idle cluster.
    expect(unanswered.length).toBeGreaterThan(0);

    // Phase 2: three new processes; every unanswered and unsent operation.
    const second = await startProcesses();
    const restartedAt = Date.now();
    expect(new Set(apps.map((app) => app.pid)).size).toBe(6);
    const rest = [...unanswered, ...operations.slice(next)];
    const responses = await Promise.all(
      rest.map(async (operation, i) => {
        if (operation.overSqs) {
          await queues.send(envelopeOf(operation.body));
          return undefined;
        }
        const response = await submit(
          second[i % 3] as HttpClient,
          operation.body,
        );
        return response.status === 200 || response.status === 202
          ? undefined
          : { status: response.status, body: response.body };
      }),
    );
    expect(responses.filter((r) => r !== undefined)).toEqual([]);

    const leftOver = async () => {
      const [pending] = (await database.owner`
        SELECT count(*)::int AS count FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND wallet_id IN ${database.owner(walletIds)}`) as {
        count: number;
      }[];
      const [unpublished] = (await database.owner`
        SELECT count(*)::int AS count FROM outbox
         WHERE published_at IS NULL
           AND wallet_id IN ${database.owner(walletIds)}`) as {
        count: number;
      }[];
      return {
        pending: pending?.count,
        unpublished: unpublished?.count,
        ...(await queues.counts('input')),
      };
    };
    const nothingLeft = { pending: 0, unpublished: 0, visible: 0, inFlight: 0 };
    let last: unknown;
    try {
      await waitFor(
        async () => {
          last = await leftOver();
          return Bun.deepEquals(last, nothingLeft);
        },
        {
          timeoutMs: Math.max(0, RECOVERY_MS - (Date.now() - restartedAt)),
          intervalMs: 250,
          description: 'every pending reference, event, and message to settle',
        },
      );
    } catch (error) {
      throw new Error(`Work left after the restart: ${JSON.stringify(last)}`, {
        cause: error,
      });
    }
    expect(await queues.deadLetters()).toEqual([]);

    // Every operation was processed exactly once.
    const statuses = (await database.owner`
      SELECT status, count(*)::int AS count FROM wager_transactions
       WHERE wallet_id IN ${database.owner(walletIds)} AND kind <> 'OPENING'
       GROUP BY status`) as { status: string; count: number }[];
    expect(statuses).toEqual([{ status: 'PROCESSED', count: OPERATIONS }]);
    const client = second[0] as HttpClient;
    for (const walletId of walletIds) {
      const wallet = await walletOf(client, walletId);
      expect({
        walletId,
        balance: wallet.balance,
        version: wallet.version,
      }).toEqual({
        walletId,
        balance: EXPECTED_BALANCE,
        version: EXPECTED_VERSION,
      });
    }
    await expectReconciled(client, walletIds);
  });
});
