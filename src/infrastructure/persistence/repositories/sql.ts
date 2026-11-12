import type { EntityManager } from '@mikro-orm/postgresql';

/** Runs raw SQL on the transaction's connection and returns the rows. */
export function query<T extends object>(
  em: EntityManager,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return em.execute<T[]>(sql, [...params], 'all');
}

/** `?, ?, …` for an `IN` list of `count` values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** `clock_timestamp()` plus `?` milliseconds, as SQL: the database clock, never the app's. */
export const CLOCK_PLUS_MS = `clock_timestamp() + (? * interval '1 millisecond')`;
