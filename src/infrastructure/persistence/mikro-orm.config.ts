import type { EntitySchema, MigrationObject } from '@mikro-orm/core';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { AppConfig } from '../config/app-config.js';

/** Statement limit set on every pooled connection; transactions tighten their own limits (§10). */
export const STATEMENT_TIMEOUT_MS = 5000;

/** How long a caller waits for a free pooled connection before failing. */
export const POOL_ACQUIRE_TIMEOUT_MS = 2000;

export type OrmConfigOverrides = {
  /** Connect with another role, such as the owner for migrations. */
  readonly clientUrl?: string;
  readonly poolMax?: number;
  readonly migrations?: MigrationObject[];
};

export function createOrmConfig(
  config: Pick<AppConfig, 'database'>,
  // oxlint-disable-next-line typescript/no-explicit-any -- MikroORM's own entity list type
  entities: EntitySchema<any, any>[],
  overrides: OrmConfigOverrides = {},
): Options {
  return defineConfig({
    clientUrl: overrides.clientUrl ?? config.database.url,
    entities,
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    ensureDatabase: false,
    pool: { min: 0, max: overrides.poolMax ?? config.database.poolMax },
    driverOptions: {
      connectionTimeoutMillis: POOL_ACQUIRE_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
    migrations: {
      migrationsList: overrides.migrations ?? [],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
  });
}
