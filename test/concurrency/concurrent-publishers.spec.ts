/**
 * Scenario 6 (challenge §11 and §13): two publishers on one outbox, plus a
 * third that dies between its send and its commit (`crash-after-send`).
 *
 * A process without the publisher commits 300 events. The crashing process
 * claims the first batch, sends it, and is killed before it records the
 * send, so those rows stay unpublished. Two publishers then start together:
 * every one of the 300 events arrives, the crashed batch is republished with
 * the same `eventId`s, and the two never publish the same row.
 *
 * SQS's five-minute FIFO window usually drops that republish. A republish
 * after the window is simulated by resending the crashed batch under new
 * deduplication IDs: a consumer that removes duplicates by `eventId` still
 * sees each event once.
 */
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { afterAll, describe, expect, it } from 'bun:test';
import { metricValue, openWallet, submit } from '../support/cluster.js';
import { settlePendingEvents, useDatabase } from '../support/database.js';
import { EventReader } from '../support/event-reader.js';
import { brl, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('concurrent-publishers');
const database = useDatabase(infrastructure);

const WALLETS = 10;
const BETS_PER_WALLET = 14;
/** An opening and each processed bet publish two events each. */
const EVENTS = WALLETS * 2 + WALLETS * BETS_PER_WALLET * 2;

const apps: SpawnedApp[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.stop()));
});

type OutboxRow = { id: string; published: boolean; attempts: number };

async function outboxOf(walletIds: readonly string[]): Promise<OutboxRow[]> {
  return (await database.owner`
    SELECT id, published_at IS NOT NULL AS published, attempts
      FROM outbox WHERE wallet_id IN ${database.owner(walletIds)}`) as OutboxRow[];
}

describe('two publishers and one killed after its send, on one outbox', () => {
  it('publishes all 300 events and republishes the interrupted batch with the same eventIds', async () => {
    await settlePendingEvents(database.owner);
    const reader = new EventReader(infrastructure);

    // 1. Commit 300 events with no publisher running.
    const writer = await spawnApp({
      env: { ...infrastructure.env, OUTBOX_PUBLISHER_ENABLED: 'false' },
    });
    apps.push(writer);
    const client = new HttpClient(writer.baseUrl);
    const wallets = await Promise.all(
      Array.from({ length: WALLETS }, () => openWallet(client, '100.00')),
    );
    await Promise.all(
      wallets.map(async (wallet) => {
        for (let i = 0; i < BETS_PER_WALLET; i += 1) {
          const response = await submit(
            client,
            wagerBody(wallet, { money: brl('1.00') }),
          );
          expect(response.body.status).toBe('PROCESSED');
        }
      }),
    );
    const walletIds = wallets.map((wallet) => wallet.id);
    const committed = await outboxOf(walletIds);
    expect(committed).toHaveLength(EVENTS);
    expect(committed.filter((row) => row.published)).toEqual([]);

    // 2. The crashing publisher sends one batch and dies before its commit.
    const crashing = await spawnApp({
      env: { ...infrastructure.env, FAULT_INJECTION: 'crash-after-send' },
      waitUntilReady: false,
    });
    apps.push(crashing);
    await crashing.exited;
    expect(crashing.output()).not.toContain('"level":"error"');
    await reader.waitUntil(
      () => reader.events().length === 10,
      15_000,
      'the crashed batch',
    );
    const crashedIds = reader.events().map((d) => d.event.eventId);
    const afterCrash = await outboxOf(walletIds);
    for (const row of afterCrash.filter((r) => crashedIds.includes(r.id))) {
      expect(row).toMatchObject({ published: false, attempts: 0 });
    }
    expect(afterCrash.filter((row) => row.published)).toEqual([]);

    // 3. Two publishers start together and take over.
    const publishers = await Promise.all([
      spawnApp({ env: infrastructure.env }),
      spawnApp({ env: infrastructure.env }),
    ]);
    apps.push(...publishers);
    expect(new Set(apps.map((app) => app.pid)).size).toBe(4);

    const allIds = committed.map((row) => row.id);
    await reader.waitForIds(allIds, 60_000);
    await waitFor(
      async () => (await outboxOf(walletIds)).every((row) => row.published),
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        description: 'every row to be marked published',
      },
    );

    // Every event once after removing duplicates; a repeat has the same body.
    const events = reader.events();
    expect(events.map((d) => d.event.eventId).toSorted()).toEqual(
      allIds.toSorted(),
    );
    for (const delivery of events) {
      expect(delivery.deduplicationId).toBe(delivery.event.eventId);
    }
    // SQS's FIFO window may drop the republished copies; any that pass are
    // repeats of the crashed batch with the same body.
    const repeats = () =>
      reader.deliveries
        .map((d) => d.event.eventId)
        .filter((id, i, ids) => ids.indexOf(id) !== i);
    for (const id of repeats()) expect(crashedIds).toContain(id);

    // A republish after the window reaches the consumer: resend the crashed
    // batch as it was sent, under new deduplication IDs. A consumer that
    // removes duplicates by eventId still sees each event once.
    const before = reader.deliveries.length;
    const crashed = events.filter((d) => crashedIds.includes(d.event.eventId));
    await infrastructure.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: infrastructure.queueUrls.events,
        Entries: crashed.map((delivery, index) => ({
          Id: String(index),
          MessageBody: delivery.body,
          MessageGroupId: delivery.groupId,
          MessageDeduplicationId: Bun.randomUUIDv7(),
        })),
      }),
    );
    await waitFor(
      async () => {
        await reader.poll();
        return reader.deliveries.length === before + crashed.length;
      },
      { timeoutMs: 15_000, intervalMs: 0, description: 'the late republish' },
    );
    expect(reader.events()).toHaveLength(EVENTS);
    const repeated = repeats();
    for (const id of crashedIds) expect(repeated).toContain(id);

    // The survivors sent every row exactly once between them, the crashed
    // batch included: none was sent by both, and none failed.
    const [first, second] = publishers.map(
      (app) => new HttpClient(app.baseUrl),
    );
    if (first === undefined || second === undefined)
      throw new Error('no publishers');
    const sample = 'outbox_publish_attempts_total{result="ok"}';
    const sentByFirst = await metricValue(first, sample);
    const sentBySecond = await metricValue(second, sample);
    expect(sentByFirst).toBeGreaterThan(0);
    expect(sentBySecond).toBeGreaterThan(0);
    expect(sentByFirst + sentBySecond).toBe(EVENTS);
    expect(
      (await outboxOf(walletIds)).filter((row) => row.attempts > 0),
    ).toEqual([]);

    await expectReconciled(first, walletIds);
  });
});
