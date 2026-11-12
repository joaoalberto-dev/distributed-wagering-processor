import { settle } from '../../domain/settlement/settle.js';
import type { RandomSource } from '../../domain/shared/backoff.js';
import { WagerTransactionStatus } from '../../domain/transaction/transaction-status.js';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import { ContentionError, OutageError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { AppLogger } from '../ports/logger.js';
import type { RequestContext } from '../ports/request-context.js';
import type { Telemetry } from '../ports/telemetry.js';
import type { TxContext, UnitOfWork } from '../ports/unit-of-work.js';
import { applyOutcome, type Outcome } from './apply-outcome.js';
import { resolveReference } from './resolve-reference.js';

export type ReferenceWorkerSettings = {
  /** IDs selected per cycle. */
  readonly batchSize: number;
  /** The random starting offset falls within the first `maxOffset` due rows. */
  readonly maxOffset: number;
  /** How far a row on a busy wallet is pushed back, without counting an attempt. */
  readonly busyPushBackMs: number;
  /** Passed to the persistence step; a worker never starts a new wait. */
  readonly referenceTtlMs: number;
};

/** The tuning table's worker values, apart from the configured TTL. */
export const REFERENCE_WORKER_DEFAULTS = {
  batchSize: 50,
  maxOffset: 200,
  busyPushBackMs: 1000,
} as const;

/** What one attempt did to one row. */
type Attempt =
  /** Not due any more, the wallet was busy, or another worker moved it first. */
  | { readonly kind: 'skipped' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'decided'; readonly transaction: WagerTransaction };

const SKIPPED: Attempt = { kind: 'skipped' };

/** A due row as read before its wallet is locked. */
type Due = {
  readonly transaction: WagerTransaction;
  readonly ttlReached: boolean;
};

/**
 * One cycle of the pending-reference worker (§11). It selects due rows from
 * a random offset and tries each in its own unit of work: the wallet lock
 * (`SKIP LOCKED`, or a blocking lock at the TTL), a re-check with the
 * database clock that coordinates the instances without a lease, the same
 * `settle` as submission, and then the persistence step or a reschedule.
 *
 * Contention skips the row, which stays due. An outage ends the cycle, so
 * the polling loop can pause. An unexpected error reschedules the row, or
 * at the TTL writes `FAILED` through the persistence step.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry,
    private readonly logger: AppLogger,
    private readonly context: RequestContext,
    private readonly settings: ReferenceWorkerSettings,
    private readonly random: RandomSource = Math.random,
  ) {}

  /** Runs one cycle and returns how many rows it selected; zero means idle. */
  async runCycle(): Promise<number> {
    const { batchSize, maxOffset } = this.settings;
    const ids = await this.unitOfWork.run(
      (tx) => tx.transactions.selectDue(batchSize, maxOffset),
      { retryContention: false },
    );
    for (const id of ids) {
      await this.context.run({ transactionId: id }, () => this.attempt(id));
    }
    return ids.length;
  }

  private async attempt(id: string): Promise<void> {
    let attempt: Attempt;
    try {
      const due = await this.unitOfWork.run((tx) => this.readDue(tx, id), {
        retryContention: false,
      });
      if (due === null) {
        attempt = SKIPPED;
      } else {
        this.context.set({
          correlationId: due.transaction.correlationId,
          walletId: due.transaction.walletId,
        });
        attempt = await this.unitOfWork.run(
          (tx) => this.resolve(tx, due.transaction, due.ttlReached),
          { retryContention: false },
        );
      }
    } catch (error) {
      if (error instanceof OutageError) throw error;
      if (error instanceof ContentionError) {
        attempt = SKIPPED;
      } else {
        attempt = await this.recover(id, error);
      }
    }
    this.record(attempt);
  }

  /** The row before its wallet is locked: still due, and whether its TTL is reached. */
  private async readDue(tx: TxContext, id: string): Promise<Due | null> {
    const check = await tx.transactions.recheck(id);
    if (check === null || !check.due) return null;
    const transaction = await tx.transactions.findById(id);
    if (transaction === null) return null;
    return { transaction, ttlReached: check.ttlReached };
  }

  /** One attempt under the wallet lock. */
  private async resolve(
    tx: TxContext,
    due: WagerTransaction,
    ttlReachedBefore: boolean,
  ): Promise<Attempt> {
    const wallet = await tx.wallets.lock(
      due.walletId,
      ttlReachedBefore ? 'wait' : 'skip-locked',
    );
    if (wallet === null) {
      // Busy: the row's own lock only, so the lock order holds.
      await tx.transactions.pushBack(due.id, this.settings.busyPushBackMs);
      return SKIPPED;
    }

    // Another worker may have handled this backoff window since the select.
    const check = await tx.transactions.recheck(due.id);
    if (check === null || !check.due) return SKIPPED;
    const transaction = await tx.transactions.findById(due.id);
    if (transaction?.status !== WagerTransactionStatus.PendingReference) {
      return SKIPPED;
    }

    const resolved = await resolveReference(tx, transaction);
    const decision = settle({
      transaction,
      wallet,
      ...resolved,
      ttlReached: check.ttlReached,
    });
    if (decision.kind === 'wait') {
      const delay = transaction.reschedule(this.random);
      const moved = await tx.transactions.reschedule(transaction.id, delay);
      return moved ? { kind: 'wait' } : SKIPPED;
    }
    await this.apply(tx, transaction, wallet, decision, resolved.reference);
    return { kind: 'decided', transaction };
  }

  /**
   * After an unexpected error: before the TTL, count the attempt and
   * reschedule; at the TTL, a new unit of work writes `FAILED`.
   */
  private async recover(id: string, cause: unknown): Promise<Attempt> {
    const reason = cause instanceof Error ? cause.name : 'unknown';
    try {
      const due = await this.unitOfWork.run((tx) => this.readDue(tx, id), {
        retryContention: false,
      });
      if (due === null) return SKIPPED;
      if (!due.ttlReached) {
        const delay = due.transaction.reschedule(this.random);
        const moved = await this.unitOfWork.run(
          (tx) => tx.transactions.reschedule(id, delay),
          { retryContention: false },
        );
        this.logger.warn('pending reference attempt failed; rescheduled', {
          transactionId: id,
          reason,
        });
        return moved ? { kind: 'wait' } : SKIPPED;
      }
      const failed = await this.unitOfWork.run(
        (tx) => this.fail(tx, due.transaction),
        { retryContention: false },
      );
      if (failed !== SKIPPED) {
        this.logger.warn('pending reference failed at its TTL', {
          transactionId: id,
          reason,
        });
      }
      return failed;
    } catch (error) {
      if (error instanceof OutageError) throw error;
      // The row stays due; the next cycle tries again.
      this.logger.warn('pending reference recovery failed', {
        transactionId: id,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return SKIPPED;
    }
  }

  /** `Failed { PROCESSING_FAILED }`, written like a rejection if the row is still pending. */
  private async fail(tx: TxContext, due: WagerTransaction): Promise<Attempt> {
    const wallet = await tx.wallets.lock(due.walletId, 'wait');
    if (wallet === null) return SKIPPED;
    const transaction = await tx.transactions.findById(due.id);
    if (transaction?.status !== WagerTransactionStatus.PendingReference) {
      return SKIPPED;
    }
    await this.apply(tx, transaction, wallet, { kind: 'fail' }, null);
    return { kind: 'decided', transaction };
  }

  private apply(
    tx: TxContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: Outcome,
    reference: WagerTransaction | null,
  ) {
    return applyOutcome(tx, transaction, wallet, outcome, {
      ids: this.ids,
      correlationId: transaction.correlationId,
      causationId: transaction.id,
      occurredAt: this.clock.now(),
      referenceTtlMs: this.settings.referenceTtlMs,
      ...(reference === null ? {} : { referenceTransactionId: reference.id }),
    });
  }

  /** Metrics and logs, after the commit. */
  private record(attempt: Attempt): void {
    if (attempt.kind !== 'decided') {
      this.telemetry.referenceAttempt(attempt.kind);
      return;
    }
    const { transaction } = attempt;
    if (transaction.status === WagerTransactionStatus.Processed) {
      this.telemetry.referenceAttempt('processed');
    } else if (transaction.status === WagerTransactionStatus.Rejected) {
      this.telemetry.referenceAttempt('rejected');
    } else {
      this.telemetry.referenceAttempt('failed');
      this.telemetry.referenceFailed();
    }
    this.telemetry.transactionDecided(
      transaction.kind,
      transaction.status,
      'worker',
    );
    const reversedBy = transaction.resultDetails?.referenceReversedBy;
    if (
      transaction.status === WagerTransactionStatus.Processed &&
      reversedBy !== undefined
    ) {
      this.logger.warn('settled against a reversed reference', {
        transactionId: transaction.id,
        kind: transaction.kind,
        referenceReversedBy: reversedBy,
      });
    }
  }
}
