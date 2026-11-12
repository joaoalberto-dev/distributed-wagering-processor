/**
 * The platform spike, kept as a regression test. Each `describe` is one item
 * of the checklist in the design's Risks & Mitigations; each test is one pass
 * criterion. Everything here is throwaway: inline entities, migrations,
 * queues and a Nest module that only exist for these checks.
 */
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  DriverException,
  LockMode,
  OptimisticLockError,
  defineEntity,
  p,
} from '@mikro-orm/core';
import { Migration, Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import {
  BulkheadFullError,
  BulkheadPolicy,
  CircuitBreakerPolicy,
  CircuitOpenError,
  RetryPolicy,
} from '@nestjs/resilience';
import { Test } from '@nestjs/testing';
import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Registry, collectDefaultMetrics } from 'prom-client';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { rejectionOf } from '../support/rejection-of.js';
import { spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('platform');

/** Suffix for every throwaway table, so reruns and parallel runs never collide. */
const RUN = randomUUID().slice(0, 8);

describe('MikroORM 7 on Bun with pg', () => {
  const tableName = `spike_accounts_${RUN}`;
  const SpikeAccount = defineEntity({
    name: 'SpikeAccount',
    tableName,
    properties: {
      id: p.uuid().primary(),
      balance: p.decimal('string').precision(14).scale(2),
      status: p.string().concurrencyCheck(),
    },
  });

  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(
      createOrmConfig(infrastructure.config, [SpikeAccount], {
        clientUrl: infrastructure.config.database.ownerUrl,
        poolMax: 4,
      }),
    );
    await orm.em
      .getConnection()
      .execute(
        `CREATE TABLE "${tableName}" (id uuid PRIMARY KEY, balance numeric(14,2) NOT NULL, status text NOT NULL)`,
      );
  });

  afterAll(async () => {
    await orm.em.getConnection().execute(`DROP TABLE IF EXISTS "${tableName}"`);
    await orm.close(true);
  });

  async function insertAccount(balance: string): Promise<string> {
    const id = randomUUID();
    const em = orm.em.fork();
    em.create(SpikeAccount, { id, balance, status: 'OPEN' });
    await em.flush();
    return id;
  }

  it('maps a defineEntity schema and reads NUMERIC(14,2) back as an exact string', async () => {
    for (const balance of ['999999999999.99', '0.10', '0.00']) {
      const id = await insertAccount(balance);
      const loaded = await orm.em.fork().findOneOrFail(SpikeAccount, id);
      expect(loaded.balance).toBe(balance);
      expect(typeof loaded.balance).toBe('string');
    }
  });

  it('PESSIMISTIC_WRITE takes a row lock that another transaction waits for', async () => {
    const id = await insertAccount('10.00');
    const lockWaitError = await orm.em.fork().transactional(async (holder) => {
      await holder.findOneOrFail(SpikeAccount, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      return rejectionOf(
        orm.em.fork().transactional(async (waiter) => {
          await waiter.execute(`SET LOCAL lock_timeout = '200ms'`);
          await waiter.findOneOrFail(SpikeAccount, id, {
            lockMode: LockMode.PESSIMISTIC_WRITE,
          });
        }),
      );
    });

    expect(lockWaitError).toBeInstanceOf(DriverException);
    expect((lockWaitError as DriverException).code).toBe('55P03');

    // Once the holder commits, the lock is free again.
    await orm.em.fork().transactional(async (em) => {
      await em.execute(`SET LOCAL lock_timeout = '200ms'`);
      await em.findOneOrFail(SpikeAccount, id, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
    });
  });

  it('concurrencyCheck refuses an update whose checked column changed meanwhile', async () => {
    const id = await insertAccount('10.00');
    const stale = orm.em.fork();
    const account = await stale.findOneOrFail(SpikeAccount, id);

    const other = orm.em.fork();
    const fresh = await other.findOneOrFail(SpikeAccount, id);
    fresh.status = 'CLOSED';
    await other.flush();

    account.status = 'FROZEN';
    account.balance = '0.00';
    expect(await rejectionOf(stale.flush())).toBeInstanceOf(
      OptimisticLockError,
    );

    const reloaded = await orm.em.fork().findOneOrFail(SpikeAccount, id);
    expect(reloaded.status).toBe('CLOSED');
    expect(reloaded.balance).toBe('10.00');
  });

  it('runs handwritten SQL migrations up and down through the Migrator API', async () => {
    const migrationTable = `spike_migrated_${RUN}`;
    class MigrationSpikeCreate extends Migration {
      override up(): void {
        this.addSql(`CREATE TABLE "${migrationTable}" (id uuid PRIMARY KEY)`);
      }
      override down(): void {
        this.addSql(`DROP TABLE "${migrationTable}"`);
      }
    }
    class MigrationSpikeColumn extends Migration {
      override up(): void {
        this.addSql(`ALTER TABLE "${migrationTable}" ADD COLUMN note text`);
      }
      override down(): void {
        this.addSql(`ALTER TABLE "${migrationTable}" DROP COLUMN note`);
      }
    }
    const config = createOrmConfig(infrastructure.config, [], {
      clientUrl: infrastructure.config.database.ownerUrl,
      poolMax: 1,
      migrations: [
        { name: '0001-spike-create', class: MigrationSpikeCreate },
        { name: '0002-spike-column', class: MigrationSpikeColumn },
      ],
    });
    const migrator = await MikroORM.init({
      ...config,
      migrations: {
        ...config.migrations,
        tableName: `spike_migrations_${RUN}`,
      },
      extensions: [Migrator],
    });
    const columns = async (): Promise<string[]> => {
      const rows = await migrator.em
        .getConnection()
        .execute<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY column_name`,
          [migrationTable],
        );
      return rows.map((row) => row.column_name);
    };

    try {
      expect((await migrator.migrator.up()).map((m) => m.name)).toEqual([
        '0001-spike-create',
        '0002-spike-column',
      ]);
      expect(await columns()).toEqual(['id', 'note']);

      expect((await migrator.migrator.down()).map((m) => m.name)).toEqual([
        '0002-spike-column',
      ]);
      expect(await columns()).toEqual(['id']);

      expect(
        (await migrator.migrator.down({ to: 0 })).map((m) => m.name),
      ).toEqual(['0001-spike-create']);
      expect(await columns()).toEqual([]);
      expect(await migrator.migrator.getExecuted()).toEqual([]);
    } finally {
      await migrator.em
        .getConnection()
        .execute(`DROP TABLE IF EXISTS "${migrationTable}"`);
      await migrator.em
        .getConnection()
        .execute(`DROP TABLE IF EXISTS "spike_migrations_${RUN}"`);
      await migrator.close(true);
    }
  });

  it('works through the Nest 12 module', async () => {
    @Injectable()
    class AccountReader {
      constructor(private readonly em: EntityManager) {}
      count(): Promise<number> {
        return this.em.fork().count(SpikeAccount);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          ...createOrmConfig(infrastructure.config, [SpikeAccount], {
            clientUrl: infrastructure.config.database.ownerUrl,
            poolMax: 1,
          }),
          registerRequestContext: false,
        }),
      ],
      providers: [AccountReader],
    }).compile();
    try {
      const reader = moduleRef.get(AccountReader);
      expect(await reader.count()).toBeGreaterThanOrEqual(0);
    } finally {
      await moduleRef.close();
    }
  });
});

describe('MiniStack SQS', () => {
  let sqs: SQSClient;
  let counter = 0;

  /** A fresh FIFO queue per test, so no test sees another's messages. */
  async function fifoQueue(
    attributes: Record<string, string> = {},
  ): Promise<string> {
    counter += 1;
    const suffix = infrastructure.config.sqs.queueSuffix;
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `spike-${counter}${suffix}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          VisibilityTimeout: '30',
          ...attributes,
        },
      }),
    );
    if (QueueUrl === undefined) throw new Error('queue has no URL');
    return QueueUrl;
  }

  async function send(
    queueUrl: string,
    group: string,
    body: string,
    dedup: string = randomUUID(),
  ) {
    return sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: group,
        MessageDeduplicationId: dedup,
      }),
    );
  }

  async function receive(
    queueUrl: string,
    max = 10,
    visibility?: number,
  ): Promise<Message[]> {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: 0,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
        MessageAttributeNames: ['All'],
        ...(visibility === undefined ? {} : { VisibilityTimeout: visibility }),
      }),
    );
    return Messages ?? [];
  }

  async function release(queueUrl: string, message: Message): Promise<void> {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  const bodies = (messages: Message[]) => messages.map((m) => m.Body);

  beforeAll(() => {
    sqs = infrastructure.sqs;
  });

  it('blocks a group while one of its messages is in flight, without blocking other groups', async () => {
    const queue = await fifoQueue();
    await send(queue, 'a', 'a1');
    await send(queue, 'a', 'a2');
    await send(queue, 'b', 'b1');

    expect(bodies(await receive(queue, 1))).toEqual(['a1']);
    expect(bodies(await receive(queue, 10))).toEqual(['b1']);
    expect(await receive(queue, 10)).toEqual([]);
  });

  it('returns several messages of one group, in order, in one receive', async () => {
    const queue = await fifoQueue();
    for (const body of ['c1', 'c2', 'c3']) await send(queue, 'c', body);

    expect(bodies(await receive(queue, 10))).toEqual(['c1', 'c2', 'c3']);
  });

  it('drops a second send with the same deduplication id inside the window', async () => {
    const queue = await fifoQueue();
    const first = await send(queue, 'd', 'first', 'same-id');
    const second = await send(queue, 'd', 'second', 'same-id');

    expect(second.MessageId).toBe(first.MessageId);
    expect(bodies(await receive(queue, 10))).toEqual(['first']);
  });

  it('counts receives in ApproximateReceiveCount', async () => {
    const queue = await fifoQueue();
    await send(queue, 'e', 'e1');

    const [first] = await receive(queue, 1);
    expect(first?.Attributes?.ApproximateReceiveCount).toBe('1');
    if (first === undefined) throw new Error('no message');
    await release(queue, first);

    const [second] = await receive(queue, 1);
    expect(second?.Attributes?.ApproximateReceiveCount).toBe('2');
  });

  it('redrives from a FIFO queue to a FIFO DLQ after maxReceiveCount', async () => {
    const dlq = await fifoQueue();
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq,
        AttributeNames: ['QueueArn'],
      }),
    );
    const queue = await fifoQueue({
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes?.QueueArn,
        maxReceiveCount: 2,
      }),
    });
    await send(queue, 'f', 'poison');

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const [message] = await receive(queue, 1);
      expect(message?.Body).toBe('poison');
      if (message === undefined) throw new Error('no message');
      await release(queue, message);
    }

    expect(await receive(queue, 1)).toEqual([]);
    const moved = await waitFor(async () => (await receive(dlq, 1))[0], {
      timeoutMs: 5000,
      description: 'the message in the DLQ',
    });
    expect(moved.Body).toBe('poison');
    expect(moved.Attributes?.MessageGroupId).toBe('f');
  });

  it('ChangeMessageVisibility releases a message at 0 and extends it beyond the original timeout', async () => {
    const queue = await fifoQueue({ VisibilityTimeout: '1' });
    await send(queue, 'g', 'released');
    const [released] = await receive(queue, 1);
    if (released === undefined) throw new Error('no message');
    await release(queue, released);
    expect(bodies(await receive(queue, 1))).toEqual(['released']);

    const other = await fifoQueue({ VisibilityTimeout: '1' });
    await send(other, 'h', 'extended');
    const [extended] = await receive(other, 1);
    if (extended === undefined) throw new Error('no message');
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: other,
        ReceiptHandle: extended.ReceiptHandle,
        VisibilityTimeout: 10,
      }),
    );
    await Bun.sleep(1500);
    expect(await receive(other, 1)).toEqual([]);
  });

  it('reports SendMessageBatch results per entry', async () => {
    const queue = await fifoQueue();
    const result = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queue,
        Entries: [
          {
            Id: 'ok',
            MessageBody: 'fine',
            MessageGroupId: 'i',
            MessageDeduplicationId: randomUUID(),
          },
          // A FIFO queue requires a group id: this entry alone must fail, as a sender fault.
          {
            Id: 'bad',
            MessageBody: 'no group',
            MessageDeduplicationId: randomUUID(),
          },
        ],
      }),
    );

    expect(result.Successful?.map((entry) => entry.Id)).toEqual(['ok']);
    expect(
      result.Failed?.map((entry) => [entry.Id, entry.SenderFault]),
    ).toEqual([['bad', true]]);
    expect(bodies(await receive(queue, 10))).toEqual(['fine']);
  });

  it('carries message attributes', async () => {
    const queue = await fifoQueue();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: 'with attributes',
        MessageGroupId: 'j',
        MessageDeduplicationId: randomUUID(),
        MessageAttributes: {
          failureReason: {
            DataType: 'String',
            StringValue: 'RETRY_BUDGET_EXHAUSTED',
          },
          receiveCount: { DataType: 'Number', StringValue: '10' },
        },
      }),
    );

    const [message] = await receive(queue, 1);
    expect(message?.MessageAttributes?.failureReason?.StringValue).toBe(
      'RETRY_BUDGET_EXHAUSTED',
    );
    expect(message?.MessageAttributes?.receiveCount).toEqual({
      DataType: 'Number',
      StringValue: '10',
    });
    if (message !== undefined) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queue,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  });
});

describe('@nestjs/resilience 0.0.3 on Bun', () => {
  class Contention extends Error {}
  class Outage extends Error {}
  class Permanent extends Error {}

  it('retries only the errors retryIf accepts', async () => {
    const retry = new RetryPolicy({
      attempts: 3,
      backoff: { delay: 1, jitter: 'full' },
      retryIf: (error) => error instanceof Contention,
    });

    let calls = 0;
    const result = await retry.execute(async ({ attempt }) => {
      calls += 1;
      if (attempt < 3) throw new Contention();
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(3);

    calls = 0;
    expect(
      await rejectionOf(
        retry.execute(async () => {
          calls += 1;
          throw new Permanent();
        }),
      ),
    ).toBeInstanceOf(Permanent);
    expect(calls).toBe(1);
  });

  it('a named bulkhead queues up to maxQueue and rejects the rest', async () => {
    const bulkhead = new BulkheadPolicy({
      name: 'spike',
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const run = (label: string) =>
      bulkhead.execute(async () => {
        order.push(label);
        if (label === 'first') await gate.promise;
        return label;
      });

    const first = run('first');
    const second = run('second');
    expect(await rejectionOf(run('third'))).toBeInstanceOf(BulkheadFullError);
    expect(bulkhead.active).toBe(1);
    expect(bulkhead.queued).toBe(1);

    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(order).toEqual(['first', 'second']);
  });

  it('a circuit breaker opens on recorded failures only and recovers through half-open', async () => {
    const breaker = new CircuitBreakerPolicy({
      name: 'spike-db',
      failureRateThreshold: 100,
      minimumCalls: 5,
      slidingWindow: { type: 'count', size: 5 },
      openDuration: 200,
      halfOpenMaxCalls: 1,
      recordIf: (error) => error instanceof Outage,
    });
    const fail = (error: Error) =>
      breaker.execute(async () => {
        throw error;
      });

    // Contention is not an outage: it never moves the breaker.
    for (let i = 0; i < 10; i += 1)
      expect(await rejectionOf(fail(new Contention()))).toBeInstanceOf(
        Contention,
      );
    expect(breaker.state).toBe('closed');

    for (let i = 0; i < 5; i += 1)
      expect(await rejectionOf(fail(new Outage()))).toBeInstanceOf(Outage);
    expect(breaker.state).toBe('open');
    expect(
      await rejectionOf(breaker.execute(async () => 'blocked')),
    ).toBeInstanceOf(CircuitOpenError);

    await Bun.sleep(250);
    expect(breaker.state).toBe('half-open');
    expect(await breaker.execute(async () => 'probe')).toBe('probe');
    expect(breaker.state).toBe('closed');
  });
});

describe('transaction_timeout', () => {
  it('surfaces as 25P04 and the pool replaces the closed connection', async () => {
    const orm = await MikroORM.init(
      createOrmConfig(infrastructure.config, [], { poolMax: 1 }),
    );
    try {
      const pidOf = async (em: EntityManager) =>
        (
          await em.execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid')
        )[0]?.pid;
      const before = await pidOf(orm.em.fork());

      const error = await rejectionOf(
        orm.em.fork().transactional(async (em) => {
          await em.execute(`SET LOCAL transaction_timeout = '100ms'`);
          await em.execute('SELECT pg_sleep(1)');
        }),
      );

      expect(error).toBeInstanceOf(DriverException);
      expect((error as DriverException).code).toBe('25P04');

      // With one connection in the pool, a working query proves the dead one was discarded.
      const after = await pidOf(orm.em.fork());
      expect(after).toBeNumber();
      expect(after).not.toBe(before);
    } finally {
      await orm.close(true);
    }
  });
});

describe('prom-client and Nest source mode on Bun', () => {
  it('registers the default metrics', async () => {
    const registry = new Registry();
    collectDefaultMetrics({ register: registry });
    const text = await registry.metrics();

    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_heap_size_used_bytes');
  });

  it('resolves constructor dependencies from the emitted decorator metadata', async () => {
    @Injectable()
    class Greeter {
      greet(): string {
        return 'hello';
      }
    }
    @Controller('spike')
    class SpikeController {
      constructor(private readonly greeter: Greeter) {}
      @Get()
      get(): string {
        return this.greeter.greet();
      }
    }
    @Module({ controllers: [SpikeController], providers: [Greeter] })
    class SpikeModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [SpikeModule],
    }).compile();
    try {
      expect(moduleRef.get(SpikeController).get()).toBe('hello');
    } finally {
      await moduleRef.close();
    }
  });

  it.each([
    ['the source (start:dev)', 'src/bootstrap/main.ts'],
    ['the build (start:prod)', 'dist/bootstrap/main.js'],
  ])('runs from %s and stops cleanly on SIGTERM', async (_, entry) => {
    const app = await spawnApp({ env: infrastructure.env, entry });
    const response = await fetch(`${app.baseUrl}/health/live`);
    expect(await response.json()).toEqual({ status: 'ok' });

    await app.stop('SIGTERM');
    expect(app.output()).not.toContain('ERROR');
  });
});

describe('the app role', () => {
  it('cannot create tables', async () => {
    const sql = new SQL(infrastructure.config.database.url);
    try {
      expect(
        String(
          await rejectionOf(
            sql.unsafe(`CREATE TABLE "spike_forbidden_${RUN}" (id int)`),
          ),
        ),
      ).toMatch(/permission denied/);
    } finally {
      await sql.close();
    }
  });
});
