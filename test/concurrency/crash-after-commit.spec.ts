/**
 * Scenario 5 (challenge §13, CUJ 4): process A commits a bet received from
 * SQS and is killed before it deletes the message. After the 5 s visibility
 * timeout a survivor receives the message again, finds the inbox row with
 * the same payload, and acknowledges it as a duplicate with no second effect.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  ledgerDirections,
  metricValue,
  openWallet,
} from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { EventReader } from '../support/event-reader.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

import {
  CHANGED,
  expectLedger,
  expectWalletEvents,
  PROCESSED,
  walletOutbox,
} from '../support/wallet-evidence.js';

const infrastructure = useInfrastructure('crash-after-commit', {
  env: { SQS_VISIBILITY_TIMEOUT_SECONDS: '5' },
});
const database = useDatabase(infrastructure);

const apps: SpawnedApp[] = [];
afterAll(async () => {
  await Promise.all(apps.map((app) => app.stop()));
});

describe('a consumer killed after commit, before the delete', () => {
  it('leaves one effect, acknowledged by a survivor as a duplicate', async () => {
    const queues = new TestQueues(infrastructure);
    const crashing = await spawnApp({
      env: { ...infrastructure.env, FAULT_INJECTION: 'crash-after-commit' },
    });
    apps.push(crashing);
    const wallet = await openWallet(new HttpClient(crashing.baseUrl), '100.00');
    const bet = wagerBody(wallet, { money: brl('25.00') });
    const envelope = envelopeOf(bet);

    await queues.send(envelope);
    await crashing.exited;
    expect(crashing.output()).not.toContain('"level":"error"');

    const committedIds = (await walletOutbox(database.app, [wallet.id])).map(
      ({ id }) => id,
    );
    expect(committedIds).toHaveLength(4);
    const survivors = await Promise.all([
      spawnApp({ env: infrastructure.env }),
      spawnApp({ env: infrastructure.env }),
    ]);
    apps.push(...survivors);
    expect(new Set(apps.map((app) => app.pid)).size).toBe(3);
    const clients = survivors.map((app) => new HttpClient(app.baseUrl));

    await waitFor(
      async () => {
        const counts = await Promise.all(
          clients.map((client) =>
            metricValue(client, 'inbox_duplicates_total'),
          ),
        );
        return counts.toSorted((a, b) => a - b).join(',') === '0,1';
      },
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        description: 'one survivor to count the duplicate',
      },
    );

    await queues.drained();
    expect(await queues.counts('input')).toEqual({ visible: 0, inFlight: 0 });
    expect(await queues.deadLetters()).toEqual([]);
    const [client] = clients;
    if (client === undefined) throw new Error('no survivor');
    expect(await ledgerDirections(client, wallet.id)).toEqual([
      'CREDIT',
      'DEBIT',
    ]);
    const [inbox] = await database.owner`
      SELECT inbox.transaction_id, wager_transactions.status
      FROM inbox JOIN wager_transactions ON wager_transactions.id = inbox.transaction_id
      WHERE message_id = ${envelope.messageId}`;
    expect(inbox?.status).toBe('PROCESSED');
    if (typeof inbox?.transaction_id !== 'string')
      throw new Error('Missing inbox transaction');
    expect(
      (await walletOutbox(database.app, [wallet.id])).map(({ id }) => id),
    ).toEqual(committedIds);
    await expectLedger(database.app, wallet.id, 2, '75.00');
    await expectWalletEvents(
      database.app,
      new EventReader(infrastructure),
      [wallet.id],
      [{ id: inbox.transaction_id, types: [PROCESSED, CHANGED] }],
    );
    await expectReconciled(client, [wallet.id]);
  });
});
