/**
 * CUJ 6: SQS is unreachable for 60 s while bets keep arriving over HTTP.
 *
 * Three processes reach MiniStack only through a TCP proxy, which the spec
 * cuts. The `sqs` circuit opens on every process; HTTP keeps committing
 * 100 bets while the outbox backlog and `outbox_lag_seconds` grow; messages
 * waiting on the input queue are never received, so no receive budget is
 * spent. After `restore()`, every event is published with the `eventId` it
 * was committed with, and the waiting messages are processed.
 */
import { describe, expect, it } from 'bun:test';
import {
  metricValue,
  openWallet,
  storedOf,
  submit,
  useCluster,
  type Wallet,
} from '../support/cluster.js';
import { settlePendingEvents, useDatabase } from '../support/database.js';
import { EventReader } from '../support/event-reader.js';
import { brl, wagerBody } from '../support/factories.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { useTcpProxy } from '../support/tcp-proxy.js';
import { waitFor } from '../support/wait-for.js';

const OUTAGE_MS = 60_000;
const WALLETS = 5;
const BETS = 100;

const infrastructure = useInfrastructure('sqs-outage');
const database = useDatabase(infrastructure);
const sqs = useTcpProxy(() => infrastructure.env.AWS_ENDPOINT_URL as string);
const cluster = useCluster(infrastructure, {
  env: () => ({
    AWS_ENDPOINT_URL: sqs.rewrite(
      infrastructure.env.AWS_ENDPOINT_URL as string,
    ),
  }),
});

async function outboxOf(
  walletIds: readonly string[],
): Promise<{ id: string; published: boolean }[]> {
  return (await database.owner`
    SELECT id, published_at IS NOT NULL AS published
      FROM outbox WHERE wallet_id IN ${database.owner(walletIds)}`) as {
    id: string;
    published: boolean;
  }[];
}

/** The value of `sample` on every process. */
function onEveryProcess(sample: string): Promise<number[]> {
  return Promise.all(
    cluster.clients.map((client) => metricValue(client, sample)),
  );
}

describe('SQS unreachable for 60 s', () => {
  it('keeps HTTP committing, spends no receive budget, and publishes every event after recovery', async () => {
    await settlePendingEvents(database.owner);
    const reader = new EventReader(infrastructure);
    const queues = new TestQueues(infrastructure);
    const wallets: Wallet[] = await Promise.all(
      Array.from({ length: WALLETS }, (_, i) =>
        openWallet(cluster.client(i), '500.00'),
      ),
    );
    const walletIds = wallets.map((wallet) => wallet.id);
    const waiting = wallets.map((wallet) =>
      wagerBody(wallet, { money: brl('1.00') }),
    );
    // The openings' events go out while SQS is still there.
    await reader.waitForIds((await outboxOf(walletIds)).map((row) => row.id));

    sqs.cut();
    const cutAt = performance.now();
    try {
      await waitFor(
        async () =>
          (await onEveryProcess('circuit_state{dependency="sqs"}')).every(
            (state) => state > 0,
          ),
        {
          timeoutMs: 30_000,
          intervalMs: 200,
          description: 'the sqs circuit to open on every process',
        },
      );

      // Messages that arrive during the outage wait on the input queue.
      for (const body of waiting) await queues.send(envelopeOf(body));

      // HTTP keeps committing.
      const bets = Array.from({ length: BETS }, (_, i) =>
        wagerBody(wallets[i % WALLETS] as Wallet, { money: brl('1.00') }),
      );
      const statuses = await Promise.all(
        bets.map(async (body, i) => {
          const response = await submit(cluster.client(i), body);
          return response.body.status;
        }),
      );
      expect(new Set(statuses)).toEqual(new Set(['PROCESSED']));

      // The backlog grows and its age rises.
      const pending = await outboxOf(walletIds);
      expect(pending.filter((row) => !row.published)).toHaveLength(BETS * 2);
      const lagEarly = Math.max(
        ...(await onEveryProcess('outbox_lag_seconds')),
      );
      expect(lagEarly).toBeGreaterThan(0);
      await Bun.sleep(Math.max(0, OUTAGE_MS - (performance.now() - cutAt)));
      const lagLate = Math.max(...(await onEveryProcess('outbox_lag_seconds')));
      expect(lagLate).toBeGreaterThan(lagEarly);

      // Nobody received the waiting messages: no receive budget was used.
      expect(await queues.counts()).toEqual({
        visible: WALLETS,
        inFlight: 0,
      });
      // The circuit is still open, or probing, on every process.
      expect(
        (await onEveryProcess('circuit_state{dependency="sqs"}')).every(
          (state) => state > 0,
        ),
      ).toBe(true);
    } finally {
      sqs.restore();
    }

    // The waiting messages are processed once the circuit closes.
    for (const body of waiting) {
      expect((await storedOf(cluster.client(0), body)).status).toBe(
        'PROCESSED',
      );
    }
    await queues.drained();

    // Every event arrives, with the eventId it was committed with.
    await waitFor(
      async () => {
        const rows = await outboxOf(walletIds);
        return rows.every((row) => row.published) ? rows : undefined;
      },
      {
        timeoutMs: 60_000,
        intervalMs: 500,
        description: 'every event of the outage to be published',
      },
    );
    const committed = (await outboxOf(walletIds)).map((row) => row.id);
    await reader.waitForIds(committed, 30_000);
    const delivered = new Set(reader.events().map((d) => d.event.eventId));
    expect(committed.filter((id) => !delivered.has(id))).toEqual([]);

    expect(await queues.deadLetters()).toEqual([]);
    expect(
      await onEveryProcess('sqs_retries_total{error_class="outage"}'),
    ).toEqual([0, 0, 0]);
    // Each process's next call after the open duration is its probe.
    await waitFor(
      async () =>
        (await onEveryProcess('circuit_state{dependency="sqs"}')).every(
          (state) => state === 0,
        ),
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        description: 'the sqs circuit to close on every process',
      },
    );
    await expectReconciled(cluster.client(0), walletIds);
  });
});
