/**
 * The operational base of a spawned process: startup warnings, the request
 * context in headers and logs, health, and metrics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { useDatabase } from '../support/database.js';
import { brl, openWalletBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('operational');
const database = useDatabase(infrastructure);

let app: SpawnedApp;
let http: HttpClient;

beforeAll(async () => {
  app = await spawnApp({ env: infrastructure.env });
  http = new HttpClient(app.baseUrl);
});

afterAll(async () => {
  await app.stop();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const logLines = (): Record<string, unknown>[] =>
  app
    .output()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('startup', () => {
  it('warns once that provider authentication is not implemented', () => {
    const warnings = logLines().filter(
      (line) =>
        line.level === 'warn' &&
        String(line.message).includes(
          'provider authentication is not implemented',
        ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.instanceId).toEqual(expect.any(String));
  });
});

describe('request context', () => {
  it('generates a request ID per request', async () => {
    const first = await http.get('/health/live');
    const second = await http.get('/health/live');
    const ids = [first, second].map((r) => r.headers.get('x-request-id'));
    for (const id of ids) expect(id).toMatch(UUID);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('replaces an invalid X-Correlation-Id and echoes a valid one', async () => {
    for (const invalid of ['has space', 'x'.repeat(129), 'çorrelation']) {
      const response = await http.get('/health/live', {
        headers: { 'x-correlation-id': invalid },
      });
      expect(response.headers.get('x-correlation-id')).toMatch(UUID);
    }
    const valid = await http.get('/health/live', {
      headers: { 'x-correlation-id': 'corr-op.1:a_b' },
    });
    expect(valid.headers.get('x-correlation-id')).toBe('corr-op.1:a_b');
  });

  it('carries a valid correlation ID into the logs of the request', async () => {
    const opened = await http.post<{ id: string }>(
      '/wallets',
      openWalletBody(brl('10.00')),
    );
    const walletId = opened.body.id;
    await database.owner.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 9.00 WHERE id = ${walletId}`;
    });

    const correlationId = `corr-${walletId}`;
    const response = await http.post(
      `/wallets/${walletId}/reconciliation`,
      undefined,
      { headers: { 'x-correlation-id': correlationId } },
    );
    expect(response.status).toBe(200);
    const line = await waitFor(
      () => logLines().find((l) => l.correlationId === correlationId),
      { timeoutMs: 2000, description: 'a log line with the correlation ID' },
    );
    expect(line).toMatchObject({
      level: 'warn',
      walletId,
      requestId: response.headers.get('x-request-id'),
      instanceId: expect.any(String) as string,
    });
  });
});

describe('health', () => {
  it('answers liveness without checking dependencies', async () => {
    const response = await http.get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports PostgreSQL, SQS, and the migration check in readiness', async () => {
    const response = await http.get<{
      status: string;
      info: Record<string, Record<string, unknown>>;
    }>('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.info).toEqual({
      postgres: { status: 'up' },
      sqs: { status: 'up' },
      migrations: {
        status: 'up',
        latest: 'Migration0007RejectionSnapshotCurrency',
      },
    });
  });
});

describe('metrics', () => {
  it('serves the Prometheus text format with the postgres circuit closed', async () => {
    const response = await http.get<string>('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.body).toContain('circuit_state{dependency="postgres"} 0');
    expect(response.body).toContain('# TYPE wager_transactions_total counter');
    expect(response.body).toContain(
      '# TYPE wager_processing_duration_seconds histogram',
    );
  });
});
