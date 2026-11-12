import type { MikroORM } from '@mikro-orm/postgresql';
import type { HealthIndicatorService } from '@nestjs/terminus';
import { LATEST_MIGRATION } from '../persistence/schema-version.js';

/** Each readiness check gives up after 1 s (tuning table). */
export const READINESS_CHECK_TIMEOUT_MS = 1000;

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
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
    private readonly health: HealthIndicatorService,
    private readonly timeoutMs = READINESS_CHECK_TIMEOUT_MS,
  ) {}

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
