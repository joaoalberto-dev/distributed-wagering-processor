/** The database every integration and concurrency spec uses; never the development one. */
export const TEST_DATABASE = 'wagering_test';

function inTestDatabase(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${TEST_DATABASE}`;
  return parsed.toString();
}

/**
 * The base environment for tests: the compose services, the test database,
 * and `NODE_ENV=test`. Connection settings already in `process.env` win, so
 * the suites can point at other hosts; the database name is always replaced.
 */
export function baseTestEnv(): Record<string, string> {
  const env = process.env;
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: env.LOG_LEVEL ?? 'warn',
    DATABASE_URL: inTestDatabase(
      env.DATABASE_URL ??
        'postgres://wagering_app:wagering_app@localhost:5432/wagering',
    ),
    DATABASE_OWNER_URL: inTestDatabase(
      env.DATABASE_OWNER_URL ??
        'postgres://wagering_owner:wagering_owner@localhost:5432/wagering',
    ),
    AWS_REGION: env.AWS_REGION ?? 'us-east-1',
    AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID ?? 'test',
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };
}
