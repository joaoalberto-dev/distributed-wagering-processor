import { describe, expect, it } from 'bun:test';
import { InvalidConfigError, loadConfig, queueNames } from './app-config.js';

describe('loadConfig', () => {
  it('uses the compose defaults when the environment is empty', () => {
    const config = loadConfig({});

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(3000);
    expect(config.database).toEqual({
      url: 'postgres://wagering_app:wagering_app@localhost:5432/wagering',
      ownerUrl:
        'postgres://wagering_owner:wagering_owner@localhost:5432/wagering',
      poolMax: 21,
      lockTimeoutMs: 2000,
    });
    expect(config.aws).toEqual({
      region: 'us-east-1',
      endpointUrl: 'http://localhost:4566',
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    expect(config.sqs).toEqual({
      queueSuffix: '',
      visibilityTimeoutSeconds: 30,
      backoffBaseMs: 2000,
      backoffCapMs: 60000,
    });
    expect(config.http).toEqual({ bulkheadSize: 11, bulkheadQueue: 50 });
    expect(config.roles).toEqual({
      http: true,
      sqsConsumer: true,
      outboxPublisher: true,
      referenceWorker: true,
    });
    expect(config.referenceTtlSeconds).toBe(86400);
    expect(config.logLevel).toBe('log');
    expect(config.faultInjection).toEqual([]);
  });

  it('generates a new instance id per load unless one is given', () => {
    expect(loadConfig({}).instanceId).not.toBe(loadConfig({}).instanceId);
    expect(loadConfig({ INSTANCE_ID: 'app-1' }).instanceId).toBe('app-1');
  });

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ PORT: '', SQS_QUEUE_SUFFIX: '' }).port).toBe(3000);
  });

  it('parses numbers and booleans', () => {
    const config = loadConfig({
      PORT: '0',
      DATABASE_POOL_MAX: '5',
      HTTP_BULKHEAD_QUEUE: '0',
      HTTP_ENABLED: 'false',
      SQS_CONSUMER_ENABLED: '0',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      REFERENCE_WORKER_ENABLED: '1',
    });

    expect(config.port).toBe(0);
    expect(config.database.poolMax).toBe(5);
    expect(config.http.bulkheadQueue).toBe(0);
    expect(config.roles).toEqual({
      http: false,
      sqsConsumer: false,
      outboxPublisher: true,
      referenceWorker: true,
    });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['DATABASE_POOL_MAX', '0'],
    ['DB_LOCK_TIMEOUT_MS', '1.5'],
    ['HTTP_ENABLED', 'maybe'],
    ['DATABASE_URL', 'mysql://localhost/wagering'],
    ['SQS_QUEUE_SUFFIX', 'has.dot'],
    ['LOG_LEVEL', 'trace'],
    ['NODE_ENV', 'staging'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(InvalidConfigError);
  });

  it('rejects a backoff base above the cap', () => {
    expect(() =>
      loadConfig({ SQS_BACKOFF_BASE_MS: '5000', SQS_BACKOFF_CAP_MS: '1000' }),
    ).toThrow(/SQS_BACKOFF_BASE_MS/);
  });

  it('refuses fault injection outside NODE_ENV=test', () => {
    expect(() => loadConfig({ FAULT_INJECTION: 'crash-after-commit' })).toThrow(
      /FAULT_INJECTION requires NODE_ENV=test/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        FAULT_INJECTION: 'crash-after-commit',
      }),
    ).toThrow(InvalidConfigError);
  });

  it('parses fault points under NODE_ENV=test', () => {
    const walletId = '0190f0c4-6b3e-7c1a-9f00-000000000001';
    const config = loadConfig({
      NODE_ENV: 'test',
      FAULT_INJECTION: ` crash-after-commit, crash-after-send ,unexpected-on-wallet:${walletId}`,
    });

    expect(config.faultInjection).toEqual([
      'crash-after-commit',
      'crash-after-send',
      `unexpected-on-wallet:${walletId}`,
    ]);
  });

  it('rejects an unknown fault point', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', FAULT_INJECTION: 'crash-everywhere' }),
    ).toThrow(/unknown fault point/);
  });

  it('returns a deeply frozen object', () => {
    const config = loadConfig({});

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.faultInjection)).toBe(true);
  });
});

describe('queueNames', () => {
  it('inserts the suffix before .fifo', () => {
    expect(queueNames(loadConfig({}))).toEqual({
      input: 'wager-transactions.fifo',
      deadLetter: 'wager-transactions-dlq.fifo',
      events: 'wagering-events.fifo',
    });
    expect(
      queueNames(loadConfig({ SQS_QUEUE_SUFFIX: '-run1-sqs' })).deadLetter,
    ).toBe('wager-transactions-dlq-run1-sqs.fifo');
  });
});
