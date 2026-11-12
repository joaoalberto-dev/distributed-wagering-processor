import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { HealthIndicatorService } from '@nestjs/terminus';
import type { SqsQueues } from '../messaging/sqs-queues.js';
import { LATEST_MIGRATION } from '../persistence/schema-version.js';

/** Each readiness check gives up after 1 s (tuning table). */
export const READINESS_CHECK_TIMEOUT_MS = 1000;

/** `work`, or a rejection once `ms` have passed. */
export async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The readiness checks of the dependencies (§18). Each names its dependency
 * in the response and never throws: a failure is a `down` result.
 */
export class ReadinessIndicators {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: Pick<SqsQueues, 'url'>,
    private readonly health: HealthIndicatorService,
    private readonly timeoutMs = READINESS_CHECK_TIMEOUT_MS,
  ) {}

  /** Asked only once shutdown began: the instance is draining. */
  draining() {
    return this.health.check('shutdown').down({ message: 'draining' });
  }

  /** PostgreSQL answers `SELECT 1`. */
  async postgres() {
    const check = this.health.check('postgres');
    try {
      await within(this.timeoutMs, this.orm.em.fork().execute('SELECT 1'));
      return check.up();
    } catch (error) {
      return check.down({ message: reason(error) });
    }
  }

  /**
   * SQS answers `GetQueueAttributes` on the input queue. The attributes call
   * bypasses the `sqs` circuit, so a readiness probe never closes it; only
   * the queue-URL lookup, made once, goes through it.
   */
  async sqsQueue() {
    const check = this.health.check('sqs');
    const abort = new AbortController();
    try {
      await within(
        this.timeoutMs,
        (async () => {
          const queueUrl = await this.queues.url('input');
          await this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: ['QueueArn'],
            }),
            { abortSignal: abort.signal },
          );
        })(),
      );
      return check.up();
    } catch (error) {
      return check.down({ message: reason(error) });
    } finally {
      abort.abort();
    }
  }

  /** The database has applied the migration this build expects last. */
  async migrations() {
    const check = this.health.check('migrations');
    try {
      const rows = await within(
        this.timeoutMs,
        this.orm.em
          .fork()
          .execute<{ name: string }[]>(
            'SELECT name FROM mikro_orm_migrations ORDER BY id DESC LIMIT 1',
          ),
      );
      const applied = rows[0]?.name ?? null;
      return applied === LATEST_MIGRATION
        ? check.up({ latest: applied })
        : check.down({ expected: LATEST_MIGRATION, applied });
    } catch (error) {
      return check.down({ expected: LATEST_MIGRATION, message: reason(error) });
    }
  }
}
