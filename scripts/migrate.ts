import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrations } from '../migrations/index.js';
import { loadConfig } from '../src/infrastructure/config/app-config.js';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config.js';

export type MigrateDirection = 'up' | 'down';

export type MigrateOptions = {
  /** For `down`: revert every migration instead of only the last one. */
  readonly all?: boolean;
};

/** Runs the migrations as the owner role and returns the names it applied or reverted. */
export async function migrate(
  direction: MigrateDirection,
  ownerUrl: string,
  options: MigrateOptions = {},
): Promise<string[]> {
  const orm = await MikroORM.init({
    ...createOrmConfig(loadConfig({}), [], {
      clientUrl: ownerUrl,
      poolMax: 1,
      migrations,
    }),
    extensions: [Migrator],
  });
  try {
    const executed =
      direction === 'up'
        ? await orm.migrator.up()
        : await orm.migrator.down(options.all === true ? { to: 0 } : undefined);
    return executed.map((migration) => migration.name);
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const [direction, flag] = process.argv.slice(2);
  if (direction !== 'up' && direction !== 'down') {
    console.error('Usage: bun scripts/migrate.ts up | down [--all]');
    process.exit(2);
  }
  const config = loadConfig(process.env);
  const names = await migrate(direction, config.database.ownerUrl, {
    all: flag === '--all',
  });
  console.log(
    names.length === 0
      ? `migrate ${direction}: nothing to do`
      : `migrate ${direction}: ${names.join(', ')}`,
  );
}
