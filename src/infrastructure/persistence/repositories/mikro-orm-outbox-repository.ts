import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../../application/ports/repositories.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { outboxMapper } from '../mappers/outbox.mapper.js';
import { OutboxRecord } from '../records/outbox.record.js';
import { CLOCK_PLUS_MS, placeholders, query } from './sql.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      this.em.create(OutboxRecord, outboxMapper.toData(message));
    }
    return Promise.resolve();
  }

  /** Concurrent publishers get disjoint sets: rows another one holds are skipped. */
  async claimDue(limit: number): Promise<OutboxMessage[]> {
    const rows = await query<Record<string, unknown>>(
      this.em,
      `SELECT * FROM outbox
        WHERE published_at IS NULL AND next_attempt_at <= clock_timestamp()
        ORDER BY next_attempt_at, id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map((row) =>
      outboxMapper.toDomain(this.em.map(OutboxRecord, row)),
    );
  }

  async markPublished(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await query(
      this.em,
      `UPDATE outbox SET published_at = clock_timestamp()
        WHERE published_at IS NULL AND id IN (${placeholders(ids.length)})`,
      ids,
    );
  }

  async scheduleRetry(
    id: string,
    backoffMs: number,
    error: string,
  ): Promise<void> {
    await query(
      this.em,
      `UPDATE outbox
          SET attempts = attempts + 1,
              next_attempt_at = ${CLOCK_PLUS_MS},
              last_error = ?
        WHERE id = ? AND published_at IS NULL`,
      [backoffMs, error, id],
    );
  }
}
