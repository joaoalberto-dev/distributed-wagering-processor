/**
 * Observability (§18, CUJ 5) against spawned processes: each required
 * metric moves after the operation that raises it, logs carry the context
 * IDs and never an amount, and readiness names a lost PostgreSQL within 2 s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  metricValue,
  openWallet,
  storedOf,
  submit,
  type Wallet,
} from '../support/cluster.js';
import { useDatabase } from '../support/database.js';
import { brl, keyOf, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { envelopeOf, TestQueues } from '../support/sqs.js';
import { useTcpProxy } from '../support/tcp-proxy.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('observability', {
  env: {
    SQS_BACKOFF_BASE_MS: '100',
    SQS_BACKOFF_CAP_MS: '1000',
    DB_LOCK_TIMEOUT_MS: '300',
  },
});
const database = useDatabase(infrastructure);
const postgres = useTcpProxy(() => infrastructure.env.DATABASE_URL as string);

/** Distinctive amounts, so the log check can look for every one of them. */
const OPENING = '913.57';
const BET = '37.13';

let app: SpawnedApp;
let http: HttpClient;
let queues: TestQueues;
const opened: string[] = [];

beforeAll(async () => {
  // The publisher is off, so the outbox backlog stays visible until a
  // publisher process is started below.
  app = await spawnApp({
    env: { ...infrastructure.env, OUTBOX_PUBLISHER_ENABLED: 'false' },
  });
  http = new HttpClient(app.baseUrl);
  queues = new TestQueues(infrastructure);
});

afterAll(async () => {
  await expectReconciled(http, opened);
  await app.stop();
});

async function open(): Promise<Wallet> {
  const wallet = await openWallet(http, OPENING);
  opened.push(wallet.id);
  return wallet;
}

const metric = (sample: string, client = http) => metricValue(client, sample);

/** Waits until `sample` reaches at least `value`. */
function metricReaches(
  sample: string,
  value: number,
  client = http,
): Promise<number> {
  return waitFor(
    async () => {
      const current = await metric(sample, client);
      return current >= value ? current : undefined;
    },
    {
      timeoutMs: 15_000,
      intervalMs: 100,
      description: `${sample} >= ${value}`,
    },
  );
}

/** Holds the wallet row lock from the test's own connection while `during` runs. */
async function holdingLock<T>(
  walletId: string,
  during: () => Promise<T>,
): Promise<T> {
  return database.owner.begin(async (tx) => {
    await tx`SELECT 1 FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    return during();
  });
}

describe('metrics', () => {
  it('counts HTTP transactions by status, replays, conflicts, latency, and lock waits', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { money: brl(BET) });
    const processed =
      'wager_transactions_total{kind="BET",status="PROCESSED",channel="http"}';
    const latency = 'wager_processing_duration_seconds_count{channel="http"}';
    const lockWaits = 'wallet_lock_wait_seconds_count{channel="http"}';
    const replays = 'idempotent_replays_total{channel="http"}';
    const conflicts =
      'idempotency_conflicts_total{code="IDEMPOTENCY_KEY_CONFLICT"}';
    const before = await Promise.all(
      [processed, latency, lockWaits, replays, conflicts].map((s) => metric(s)),
    );

    expect((await submit(http, body)).status).toBe(200);
    expect((await submit(http, body)).status).toBe(200);
    const conflict = await http.post(
      '/wagering/transactions',
      { ...body, money: brl('1.00') },
      { headers: keyOf(body) },
    );
    expect(conflict.status).toBe(409);

    expect(await metric(processed)).toBe((before[0] as number) + 1);
    // The first submission and the replay.
    expect(await metric(latency)).toBe((before[1] as number) + 2);
    expect(await metric(lockWaits)).toBe((before[2] as number) + 1);
    expect(await metric(replays)).toBe((before[3] as number) + 1);
    expect(await metric(conflicts)).toBe((before[4] as number) + 1);
  });

  it('records a lock wait in its bucket and counts lock timeouts', async () => {
    const wallet = await open();
    const fast = 'wallet_lock_wait_seconds_bucket{le="0.1",channel="http"}';
    const all = 'wallet_lock_wait_seconds_count{channel="http"}';
    const timeouts = 'wallet_lock_timeouts_total';
    const [fastBefore, allBefore, timeoutsBefore] = await Promise.all(
      [fast, all, timeouts].map((s) => metric(s)),
    );

    // Released after 150 ms: a wait within the 300 ms lock timeout.
    const { waiting } = await holdingLock(wallet.id, async () => {
      const pending = submit(http, wagerBody(wallet, { money: brl(BET) }));
      await Bun.sleep(150);
      return { waiting: pending };
    });
    expect((await waiting).status).toBe(200);
    // Counted once, above the 0.1 s bucket.
    expect(await metric(all)).toBe((allBefore as number) + 1);
    expect(await metric(fast)).toBe(fastBefore as number);

    // Held past three attempts: each attempt times out.
    const blocked = wagerBody(wallet, { money: brl(BET) });
    const refused = await holdingLock(wallet.id, () =>
      http.post('/wagering/transactions', blocked, {
        headers: keyOf(blocked),
      }),
    );
    expect(refused.status).toBe(503);
    expect(await metric(timeouts)).toBe((timeoutsBefore as number) + 3);
  });

  it('counts SQS transactions, duplicates, message-ID conflicts, retries, and DLQ moves', async () => {
    const wallet = await open();
    const sqsProcessed =
      'wager_transactions_total{kind="BET",status="PROCESSED",channel="sqs"}';
    const duplicates = 'inbox_duplicates_total';
    const idConflicts = 'message_id_conflicts_total';
    const dlqMoves = 'sqs_dlq_moves_total{reason="MESSAGE_ID_CONFLICT"}';
    const retries = 'sqs_retries_total{error_class="contention"}';
    const [processedBefore, duplicatesBefore, conflictsBefore, movesBefore] =
      await Promise.all(
        [sqsProcessed, duplicates, idConflicts, dlqMoves].map((s) => metric(s)),
      );
    const retriesBefore = await metric(retries);

    const body = wagerBody(wallet, { money: brl(BET) });
    const envelope = envelopeOf(body);
    await queues.send(envelope);
    await storedOf(http, body);
    await metricReaches(sqsProcessed, (processedBefore as number) + 1);

    await queues.send(envelope);
    await metricReaches(duplicates, (duplicatesBefore as number) + 1);

    const reused = envelopeOf(wagerBody(wallet, { money: brl(BET) }), {
      messageId: envelope.messageId,
    });
    await queues.send(reused);
    await metricReaches(idConflicts, (conflictsBefore as number) + 1);
    await metricReaches(dlqMoves, (movesBefore as number) + 1);
    // Read at scrape from the DLQ, before the test collects it.
    expect(await metric('sqs_dlq_depth')).toBeGreaterThanOrEqual(1);
    await queues.deadLetter((m) => m.messageId === envelope.messageId);

    // The consumer's lock waits time out while the test holds the lock.
    const contended = wagerBody(wallet, { money: brl(BET) });
    await holdingLock(wallet.id, async () => {
      await queues.send(envelopeOf(contended));
      await metricReaches(retries, retriesBefore + 1);
    });
    await storedOf(http, contended);
  });

  it('reports the outbox backlog and pending references, then the publisher drains it', async () => {
    const wallet = await open();
    const refundBeforeBet = wagerBody(wallet, {
      kind: 'REFUND',
      money: brl(BET),
      referenceExternalTransactionId: `missing-${Bun.randomUUIDv7()}`,
    });
    const waits = 'reference_attempts_total{outcome="wait"}';
    const waitsBefore = await metric(waits);

    expect((await submit(http, refundBeforeBet)).status).toBe(202);
    expect(await metric('pending_references')).toBeGreaterThanOrEqual(1);
    await metricReaches(waits, waitsBefore + 1);

    // Every event of this spec so far waits for a publisher.
    expect(await metric('outbox_pending')).toBeGreaterThanOrEqual(1);
    expect(await metric('outbox_lag_seconds')).toBeGreaterThan(0);
    expect(await metric('db_pool_in_use')).toBeGreaterThanOrEqual(0);
    expect(await metric('circuit_state{dependency="postgres"}')).toBe(0);

    const publisher = await spawnApp({
      env: {
        ...infrastructure.env,
        HTTP_ENABLED: 'false',
        SQS_CONSUMER_ENABLED: 'false',
        REFERENCE_WORKER_ENABLED: 'false',
      },
    });
    try {
      const publisherHttp = new HttpClient(publisher.baseUrl);
      await metricReaches(
        'outbox_publish_attempts_total{result="ok"}',
        1,
        publisherHttp,
      );
      await waitFor(async () => (await metric('outbox_pending')) === 0, {
        timeoutMs: 15_000,
        intervalMs: 200,
        description: 'the outbox backlog to drain',
      });
      expect(await metric('outbox_lag_seconds')).toBe(0);
    } finally {
      await publisher.stop();
    }
  });
});

type LogLine = Record<string, unknown>;

function logLines(output: string): LogLine[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogLine);
}

/** Every key and string value in `value`, at any depth. */
function* entries(value: unknown): Generator<[string, unknown]> {
  if (value === null || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    yield [key, inner];
    yield* entries(inner);
  }
}

describe('logs', () => {
  it('carry the context IDs of HTTP and SQS operations', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet, { money: brl(BET) });
    expect((await submit(http, bet)).status).toBe(200);
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      money: brl(BET),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submit(http, refund)).status).toBe(200);

    // A WIN on a refunded bet is processed and logged as a warning (D9).
    const correlationId = `corr-${Bun.randomUUIDv7()}`;
    const win = wagerBody(wallet, {
      kind: 'WIN',
      money: brl(BET),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const settled = await http.post<{ transactionId: string }>(
      '/wagering/transactions',
      win,
      { headers: { ...keyOf(win), 'x-correlation-id': correlationId } },
    );
    expect(settled.status).toBe(200);

    // A reused messageId is logged with the SQS IDs.
    const first = envelopeOf(wagerBody(wallet, { money: brl(BET) }));
    const sqsMessageId = await queues.send(first);
    await storedOf(http, first.data);
    const reused = envelopeOf(wagerBody(wallet, { money: brl(BET) }), {
      messageId: first.messageId,
    });
    const reusedSqsId = await queues.send(reused);
    await queues.deadLetter((m) => m.messageId === first.messageId);

    const lines = await waitFor(
      () => {
        const all = logLines(app.output());
        const http_ = all.find((l) => l.correlationId === correlationId);
        const sqs = all.find(
          (l) =>
            l.messageId === first.messageId && l.sqsMessageId === reusedSqsId,
        );
        return http_ !== undefined && sqs !== undefined
          ? { http: http_, sqs }
          : undefined;
      },
      { timeoutMs: 10_000, description: 'the HTTP and SQS warnings' },
    );
    expect(sqsMessageId).not.toBe(reusedSqsId);
    expect(lines.http).toMatchObject({
      level: 'warn',
      message: 'settled against a reversed reference',
      correlationId,
      requestId: settled.headers.get('x-request-id'),
      providerId: win.providerId,
      walletId: wallet.id,
      transactionId: settled.body.transactionId,
    });
    expect(lines.http.instanceId).toBeString();
    expect(lines.sqs).toMatchObject({
      level: 'warn',
      message: 'message ID reused for another operation',
      walletId: wallet.id,
      providerId: reused.data.providerId,
    });
    expect(lines.sqs.instanceId).toBe(lines.http.instanceId);
  });

  it('never carry an amount, a balance, or a payload', () => {
    const lines = logLines(app.output());
    expect(lines.length).toBeGreaterThan(0);
    const amounts = new Set([OPENING, BET]);
    const offending = lines.filter((line) =>
      [...entries(line)].some(
        ([key, value]) =>
          /^(amount|balance|money|payload)$/i.test(key) ||
          (typeof value === 'string' && /^-?\d+\.\d{2}$/.test(value)),
      ),
    );
    expect(offending).toEqual([]);
    for (const amount of amounts) expect(app.output()).not.toContain(amount);
  });
});

describe('readiness', () => {
  it('answers 503 naming postgres within 2 s of losing it, and 200 once it is back', async () => {
    const proxied = await spawnApp({
      env: {
        ...infrastructure.env,
        DATABASE_URL: postgres.rewrite(
          infrastructure.env.DATABASE_URL as string,
        ),
        SQS_CONSUMER_ENABLED: 'false',
        OUTBOX_PUBLISHER_ENABLED: 'false',
        REFERENCE_WORKER_ENABLED: 'false',
      },
    });
    const client = new HttpClient(proxied.baseUrl);
    type Health = {
      status: string;
      error: Record<string, { status: string; message?: string }>;
    };
    try {
      expect((await client.get('/health/ready')).status).toBe(200);

      const cutAt = performance.now();
      postgres.cut();
      const down = await waitFor(
        async () => {
          const response = await client.get<Health>('/health/ready');
          return response.status === 503 ? response : undefined;
        },
        { timeoutMs: 2000, intervalMs: 50, description: 'readiness to fail' },
      );
      expect(performance.now() - cutAt).toBeLessThan(2000);
      expect(down.body.status).toBe('error');
      expect(down.body.error.postgres?.status).toBe('down');
      expect(down.body.error.sqs).toBeUndefined();
      // Liveness never checks a dependency.
      expect((await client.get('/health/live')).status).toBe(200);

      postgres.restore();
      await waitFor(
        async () => (await client.get('/health/ready')).status === 200,
        { timeoutMs: 10_000, intervalMs: 100, description: 'readiness back' },
      );
    } finally {
      postgres.restore();
      await proxied.stop();
    }
  });
});
