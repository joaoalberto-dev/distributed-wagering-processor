import type { RequiredEntityData } from '@mikro-orm/core';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import type { OutboxRecord } from '../records/outbox.record.js';

export const outboxMapper = {
  toDomain(record: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      walletId: record.walletId,
      eventType: record.eventType,
      eventVersion: record.eventVersion,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      publishedAt: record.publishedAt ?? null,
      lastError: record.lastError ?? null,
    });
  },

  /** A new row: due at once (`next_attempt_at` defaults to the database `now()`). */
  toData(message: OutboxMessage): RequiredEntityData<OutboxRecord> {
    const state = message.toState();
    return {
      id: state.id,
      aggregateId: state.aggregateId,
      walletId: state.walletId,
      eventType: state.eventType,
      eventVersion: state.eventVersion,
      payload: { ...state.payload },
      occurredAt: state.occurredAt,
      attempts: state.attempts,
      publishedAt: state.publishedAt,
      lastError: state.lastError,
    };
  },
};
