/**
 * Shutdown on `SIGTERM` (§12): with 20 messages in flight, the message in
 * progress in each group finishes, the ones not started are released at
 * once, readiness answers 503 while the process drains, and a second
 * process processes the rest with nothing in the DLQ.
 *
 * The test holds the four wallets' row locks, so each group's first message
 * is in progress, waiting on its lock, when `SIGTERM` arrives. The lock
 * timeout is longer than the hold, so no message backs off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { openWallet, storedOf, type Wallet } from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

const GROUPS = 4;
const PER_GROUP = 5;

const infrastructure = useInfrastructure('shutdown', {
  env: { DB_LOCK_TIMEOUT_MS: '10000' },
});
const database = useDatabase(infrastructure);

/** Only the publisher and the worker are off: neither takes part here. */
const consumerEnv = () => ({
  ...infrastructure.env,
  OUTBOX_PUBLISHER_ENABLED: 'false',
  REFERENCE_WORKER_ENABLED: 'false',
});

let first: SpawnedApp;
let http: HttpClient;
let queues: TestQueues;

beforeAll(async () => {
  first = await spawnApp({ env: consumerEnv() });
  http = new HttpClient(first.baseUrl);
  queues = new TestQueues(infrastructure);
});

afterAll(async () => {
  await first.stop('SIGKILL');
});

/** Bets of these wallets the database holds. */
async function storedBets(wallets: readonly Wallet[]): Promise<number> {
  const ids = wallets.map((w) => w.id);
  const [row] = await database.app<{ count: string }[]>`
    SELECT count(*) AS count FROM wager_transactions
     WHERE kind = 'BET' AND wallet_id IN ${database.app(ids)}`;
  return Number(row?.count ?? 0);
}

/** Backends of the test database waiting for a row lock. */
async function lockWaiters(): Promise<number> {
  const [row] = await database.owner<{ count: string }[]>`
    SELECT count(*) AS count FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return Number(row?.count ?? 0);
}

describe('SIGTERM with messages in flight', () => {
  it('finishes the messages in progress, releases the rest, and loses none', async () => {
    const wallets: Wallet[] = [];
    for (let i = 0; i < GROUPS; i += 1) {
      wallets.push(await openWallet(http, '100.00'));
    }
    const bodies = wallets.flatMap((wallet) =>
      Array.from({ length: PER_GROUP }, () =>
        wagerBody(wallet, { money: brl('1.00') }),
      ),
    );

    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = database.owner.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id IN ${tx(wallets.map((w) => w.id))} FOR UPDATE`;
      await released;
    });

    let stopped: Promise<number | null> | undefined;
    try {
      for (const wallet of wallets) {
        await queues.sendBatch(
          bodies
            .filter((body) => body.walletId === wallet.id)
            .map((body) => envelopeOf(body)),
          wallet.id,
        );
      }
      // One message of each group is in progress, blocked on its wallet.
      await waitFor(async () => (await lockWaiters()) >= GROUPS, {
        timeoutMs: 15_000,
        intervalMs: 100,
        description: `${GROUPS} consumer transactions waiting on their wallets`,
      });
      expect(await storedBets(wallets)).toBe(0);

      stopped = first.stop('SIGTERM');
      const draining = await waitFor(
        async () => {
          const response = await http.get<{
            error: Record<string, { status: string; message?: string }>;
          }>('/health/ready');
          return response.status === 503 ? response : undefined;
        },
        { timeoutMs: 5000, intervalMs: 50, description: 'readiness to fail' },
      );
      expect(draining.body.error.shutdown).toEqual({
        status: 'down',
        message: 'draining',
      });
    } finally {
      release();
      await holding;
    }

    await stopped;
    // The message in progress in each group committed before the exit...
    expect(await storedBets(wallets)).toBe(GROUPS);
    // ...and every other message is back in the queue at once, long before
    // its 30 s visibility timeout.
    await waitFor(
      async () => {
        const counts = await queues.counts();
        return counts.inFlight === 0 &&
          counts.visible === GROUPS * PER_GROUP - GROUPS
          ? counts
          : undefined;
      },
      { timeoutMs: 5000, intervalMs: 100, description: 'the rest released' },
    );

    const second = await spawnApp({ env: consumerEnv() });
    try {
      const secondHttp = new HttpClient(second.baseUrl);
      for (const body of bodies) {
        expect((await storedOf(secondHttp, body)).status).toBe('PROCESSED');
      }
      await queues.drained();
      expect(await queues.deadLetters()).toEqual([]);
      await expectReconciled(
        secondHttp,
        wallets.map((w) => w.id),
      );
    } finally {
      await second.stop();
    }
  });
});
