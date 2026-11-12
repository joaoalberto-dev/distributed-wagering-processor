import type { MigrationObject } from '@mikro-orm/core';

/**
 * Every migration, in the order it runs. Each entry names its class
 * explicitly, so the stored name survives bundling. The first migrations
 * arrive with the schema (task 04).
 */
export const migrations: MigrationObject[] = [];

/** The name of the last migration; readiness compares the database against it. */
export const LATEST_MIGRATION: string | null = migrations.at(-1)?.name ?? null;
