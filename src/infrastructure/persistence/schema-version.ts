/**
 * The name of the last migration. Readiness checks that the database has
 * applied it. It lives here because the build compiles only `src/`;
 * `migrations/index.ts` re-exports it, and the migrations spec checks that
 * it names the last migration in the list.
 */
export const LATEST_MIGRATION = 'Migration0008InboxImmutable';
