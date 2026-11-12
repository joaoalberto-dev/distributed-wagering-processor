import type { FilterQuery } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  PendingSchedule,
  TransactionRepository,
} from '../../../application/ports/repositories.js';
import { WagerTransactionStatus } from '../../../domain/transaction/transaction-status.js';
import type { WagerTransaction } from '../../../domain/transaction/wager-transaction.js';
import {
  type PendingTimes,
  wagerTransactionMapper,
} from '../mappers/wager-transaction.mapper.js';
import { WagerTransactionRecord } from '../records/wager-transaction.record.js';
import { CLOCK_PLUS_MS, query } from './sql.js';

type IdRow = { id: string };

/** Due: still pending and its next attempt time has come, by the database clock. */
const DUE = `status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= clock_timestamp()`;

export class MikroOrmTransactionRepository implements TransactionRepository {
  constructor(
    private readonly em: EntityManager,
    /** Picks the worker's starting offset; replaceable in tests. */
    private readonly random: () => number = Math.random,
  ) {}

  findByKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId: externalId });
  }

  findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne({ id });
  }

  findSuccessfulReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne({
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
  }

  async insert(
    transaction: WagerTransaction,
    pending?: PendingSchedule,
  ): Promise<{ referenceExpiresAt?: Date }> {
    const isPending =
      transaction.status === WagerTransactionStatus.PendingReference;
    if (isPending !== (pending !== undefined)) {
      throw new Error(
        `transaction ${transaction.id}: a schedule is required exactly for PENDING_REFERENCE`,
      );
    }
    const times = pending === undefined ? undefined : await this.times(pending);
    this.em.create(
      WagerTransactionRecord,
      wagerTransactionMapper.toData(transaction, times),
    );
    return times === undefined
      ? {}
      : { referenceExpiresAt: times.referenceExpiresAt };
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, {
      id: transaction.id,
    });
    wagerTransactionMapper.applyTo(record, transaction);
  }

  async reschedule(id: string, backoffMs: number): Promise<boolean> {
    const rows = await query<IdRow>(
      this.em,
      `UPDATE wager_transactions
          SET attempts = attempts + 1,
              next_reference_attempt_at = LEAST(${CLOCK_PLUS_MS}, reference_expires_at),
              updated_at = clock_timestamp()
        WHERE id = ? AND ${DUE}
        RETURNING id`,
      [backoffMs, id],
    );
    return rows.length > 0;
  }

  async pushBack(id: string, delayMs: number): Promise<boolean> {
    const rows = await query<IdRow>(
      this.em,
      `UPDATE wager_transactions
          SET next_reference_attempt_at = LEAST(${CLOCK_PLUS_MS}, reference_expires_at),
              updated_at = clock_timestamp()
        WHERE id = ? AND ${DUE}
        RETURNING id`,
      [delayMs, id],
    );
    return rows.length > 0;
  }

  async wakeDependents(
    walletId: string,
    providerId: string,
    externalId: string,
  ): Promise<number> {
    const rows = await query<IdRow>(
      this.em,
      `UPDATE wager_transactions
          SET next_reference_attempt_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE status = 'PENDING_REFERENCE'
          AND provider_id = ?
          AND reference_external_transaction_id = ?
          AND wallet_id = ?
          AND next_reference_attempt_at > clock_timestamp()
        RETURNING id`,
      [providerId, externalId, walletId],
    );
    return rows.length;
  }

  async selectDue(limit: number, maxOffset: number): Promise<string[]> {
    const [counted] = await query<{ due: number }>(
      this.em,
      `SELECT count(*)::int AS due
         FROM (SELECT 1 FROM wager_transactions WHERE ${DUE} LIMIT ?) AS due_window`,
      [maxOffset],
    );
    const due = counted?.due ?? 0;
    if (due === 0) return [];
    const page = (offset: number) =>
      query<IdRow>(
        this.em,
        `SELECT id FROM wager_transactions
          WHERE ${DUE}
          ORDER BY next_reference_attempt_at, id
          OFFSET ? LIMIT ?`,
        [offset, limit],
      );
    const offset = Math.floor(this.random() * due);
    let rows = await page(offset);
    // Rows may have stopped being due since the count; start over from the first.
    if (rows.length === 0 && offset > 0) rows = await page(0);
    return rows.map((row) => row.id);
  }

  async recheck(
    id: string,
  ): Promise<{ due: boolean; ttlReached: boolean } | null> {
    const [row] = await query<{ due: boolean; ttl_reached: boolean }>(
      this.em,
      `SELECT COALESCE(${DUE}, false) AS due,
              COALESCE(reference_expires_at <= clock_timestamp(), false) AS ttl_reached
         FROM wager_transactions
        WHERE id = ?`,
      [id],
    );
    return row === undefined
      ? null
      : { due: row.due, ttlReached: row.ttl_reached };
  }

  private async findOne(
    where: FilterQuery<WagerTransactionRecord>,
  ): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, where);
    return record === null ? null : wagerTransactionMapper.toDomain(record);
  }

  /**
   * The schedule from the database clock, rounded as the `timestamptz(3)`
   * columns round it, so the returned expiry equals the stored one.
   */
  private async times(pending: PendingSchedule): Promise<PendingTimes> {
    const epochMs = (expression: string) =>
      `(extract(epoch FROM (${expression})::timestamptz(3)) * 1000)::bigint::text`;
    const [row] = await query<{ next: string; expires: string }>(
      this.em,
      `SELECT ${epochMs(`LEAST(${CLOCK_PLUS_MS}, ${CLOCK_PLUS_MS})`)} AS next,
              ${epochMs(CLOCK_PLUS_MS)} AS expires`,
      [pending.backoffMs, pending.ttlMs, pending.ttlMs],
    );
    if (row === undefined) {
      throw new Error('the database clock returned no row');
    }
    return {
      nextReferenceAttemptAt: new Date(Number(row.next)),
      referenceExpiresAt: new Date(Number(row.expires)),
    };
  }
}
