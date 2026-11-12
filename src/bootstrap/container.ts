import { MikroORM } from '@mikro-orm/postgresql';
import type { Clock } from '../application/ports/clock.js';
import type { IdGenerator } from '../application/ports/id-generator.js';
import type { UnitOfWork } from '../application/ports/unit-of-work.js';
import { SystemClock } from '../infrastructure/clock/system-clock.js';
import type { AppConfig } from '../infrastructure/config/app-config.js';
import { UuidV7Generator } from '../infrastructure/ids/uuid-v7-generator.js';
import { createOrmConfig } from '../infrastructure/persistence/mikro-orm.config.js';
import {
  type ContentionRetry,
  DEFAULT_TIMEOUTS,
  MikroOrmUnitOfWork,
  NO_RETRY,
  type UnitOfWorkTimeouts,
} from '../infrastructure/persistence/mikro-orm-unit-of-work.js';
import { PERSISTENCE_RECORDS } from '../infrastructure/persistence/records/index.js';

/** Replacements for in-process tests; anything left out is the production adapter. */
export type ApplicationOverrides = {
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly retryContention?: ContentionRetry;
  readonly timeouts?: Partial<UnitOfWorkTimeouts>;
};

/** The application graph: every port adapter and use case, built without Nest. */
export type Application = {
  readonly config: AppConfig;
  readonly orm: MikroORM;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  close(): Promise<void>;
};

/**
 * Builds the application graph. Nest modules only expose what it returns,
 * and in-process tests build the same graph with failing adapters.
 */
export async function buildApplication(
  config: AppConfig,
  overrides: ApplicationOverrides = {},
): Promise<Application> {
  const orm = await MikroORM.init(createOrmConfig(config, PERSISTENCE_RECORDS));
  const unitOfWork = new MikroOrmUnitOfWork(
    orm,
    {
      ...DEFAULT_TIMEOUTS,
      lockTimeoutMs: config.database.lockTimeoutMs,
      ...overrides.timeouts,
    },
    overrides.retryContention ?? NO_RETRY,
  );
  return {
    config,
    orm,
    unitOfWork,
    clock: overrides.clock ?? new SystemClock(),
    ids: overrides.ids ?? new UuidV7Generator(),
    close: () => orm.close(true),
  };
}
