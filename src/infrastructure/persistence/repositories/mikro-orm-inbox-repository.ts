import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../../../application/ports/repositories.js';
import type { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { inboxMapper } from '../mappers/inbox.mapper.js';
import { InboxRecord } from '../records/inbox.record.js';
import { query } from './sql.js';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxRecord, {
      consumerName,
      messageId,
    });
    return record === null ? null : inboxMapper.toDomain(record);
  }

  /**
   * Inserted at once, not at the flush, so a concurrent delivery of the same
   * message waits here, before the wallet lock (§10, lock order).
   */
  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const state = message.toState();
    const rows = await query<{ message_id: string }>(
      this.em,
      `INSERT INTO inbox (consumer_name, message_id, payload_hash, idempotency_key,
                          transaction_id, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        state.consumerName,
        state.messageId,
        state.payloadHash,
        state.idempotencyKey,
        state.transactionId,
        state.receivedAt,
        state.processedAt,
      ],
    );
    return rows.length > 0;
  }
}
