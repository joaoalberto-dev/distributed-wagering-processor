import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** The `inbox` row: one SQS delivery per `(consumer_name, message_id)`. Inserted with raw SQL. */
export const InboxRecord = defineEntity({
  name: 'InboxRecord',
  tableName: 'inbox',
  properties: {
    consumerName: p.string().length(64).primary(),
    messageId: p.string().length(128).primary(),
    payloadHash: p.string().length(70),
    idempotencyKey: p.string().length(255),
    transactionId: p.uuid(),
    receivedAt: p.datetime(3),
    processedAt: p.datetime(3),
  },
});

export type InboxRecord = InferEntity<typeof InboxRecord>;
