import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** The `outbox` row: one integration event, retried until published. */
export const OutboxRecord = defineEntity({
  name: 'OutboxRecord',
  tableName: 'outbox',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    walletId: p.uuid(),
    eventType: p.string().length(64),
    eventVersion: p.integer(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(3),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(3).nullable(),
    publishedAt: p.datetime(3).nullable(),
    lastError: p.string().nullable(),
  },
});

export type OutboxRecord = InferEntity<typeof OutboxRecord>;
