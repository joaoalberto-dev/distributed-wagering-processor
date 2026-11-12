import type { FailureCode, RejectionCode } from '../failure-code.js';
import { Money } from '../money/money.js';
import {
  backoffDelay,
  type BackoffPolicy,
  type RandomSource,
} from '../shared/backoff.js';
import {
  InvalidTransitionError,
  InvariantViolationError,
} from '../shared/domain-error.js';
import {
  allowsZeroAmount,
  REFERENCE_RULE,
  type SubmittableKind,
  WagerTransactionKind,
} from './transaction-kind.js';
import {
  canTransition,
  isTerminal,
  WagerTransactionStatus,
} from './transaction-status.js';

/** The pending-reference retry backoff: base 1 s, cap 5 min. */
export const REFERENCE_BACKOFF: BackoffPolicy = {
  baseMs: 1000,
  capMs: 300_000,
};

/** The reference field named by `REFERENCE_MISMATCH`. */
export type ReferenceField =
  | 'playerId'
  | 'walletId'
  | 'currency'
  | 'roundId'
  | 'amount';

/** Persisted as `result_details` and replayed with the result. */
export type ResultDetails = {
  readonly field?: ReferenceField;
  /** The `transactionId` of the reversal that already reversed the reference. */
  readonly referenceReversedBy?: string;
};

export type WagerTransactionState = {
  readonly id: string;
  /** Provider fields are null only for `OPENING`. */
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly idempotencyKey: string | null;
  readonly payloadHash: string | null;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** The provider's ID of the referenced operation, not the internal ID. */
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly resultDetails: ResultDetails | null;
  /** The wallet balance when the result was decided; null while pending and for `FAILED`. */
  readonly resultBalance: Money | null;
  readonly correlationId: string;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly processedAt: Date | null;
};

export type CreateWagerTransactionProps = {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: SubmittableKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId: string;
  readonly at: Date;
};

export type OpenWagerTransactionProps = {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly correlationId: string;
  readonly at: Date;
};

type Decided = {
  readonly balance: Money;
  readonly details?: ResultDetails;
  readonly at: Date;
};

/**
 * A provider operation, or the internal `OPENING` credit, and its result.
 *
 * It starts as `PENDING` in memory. `PROCESSED`, `REJECTED`, and `FAILED` are
 * terminal: any further transition throws `InvalidTransitionError`.
 */
export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  /** A provider operation, `PENDING`. Enforces the per-kind rules V4–V7. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const kind = props.kind;
    // The type excludes OPENING; this guards callers that cast around it.
    if ((kind as WagerTransactionKind) === WagerTransactionKind.Opening) {
      throw new InvariantViolationError('OPENING is internal; use open()');
    }
    const reference = props.referenceExternalTransactionId ?? null;
    const rule = REFERENCE_RULE[kind];
    if (rule === 'required' && reference === null) {
      throw new InvariantViolationError(`${kind} requires a reference`);
    }
    if (rule === 'forbidden' && reference !== null) {
      throw new InvariantViolationError(`${kind} must not carry a reference`);
    }
    if (reference !== null && reference === props.externalTransactionId) {
      throw new InvariantViolationError(
        'a transaction cannot reference itself',
      );
    }
    assertAmount(kind, props.money);
    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind,
      money: props.money,
      referenceExternalTransactionId: reference,
      referenceTransactionId: null,
      status: WagerTransactionStatus.Pending,
      failureCode: null,
      resultDetails: null,
      resultBalance: null,
      correlationId: props.correlationId,
      attempts: 0,
      createdAt: props.at,
      processedAt: null,
    });
  }

  /** The internal `OPENING` credit, `PENDING`, with no provider fields. */
  static open(props: OpenWagerTransactionProps): WagerTransaction {
    assertAmount(WagerTransactionKind.Opening, props.money);
    return new WagerTransaction({
      id: props.id,
      providerId: null,
      externalTransactionId: null,
      idempotencyKey: null,
      payloadHash: null,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: null,
      gameId: null,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: WagerTransactionStatus.Pending,
      failureCode: null,
      resultDetails: null,
      resultBalance: null,
      correlationId: props.correlationId,
      attempts: 0,
      createdAt: props.at,
      processedAt: null,
    });
  }

  /** Rebuilds persisted state without re-validating transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id(): string {
    return this.state.id;
  }
  get providerId(): string | null {
    return this.state.providerId;
  }
  get externalTransactionId(): string | null {
    return this.state.externalTransactionId;
  }
  get idempotencyKey(): string | null {
    return this.state.idempotencyKey;
  }
  get payloadHash(): string | null {
    return this.state.payloadHash;
  }
  get walletId(): string {
    return this.state.walletId;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get roundId(): string | null {
    return this.state.roundId;
  }
  get gameId(): string | null {
    return this.state.gameId;
  }
  get kind(): WagerTransactionKind {
    return this.state.kind;
  }
  get money(): Money {
    return this.state.money;
  }
  get referenceExternalTransactionId(): string | null {
    return this.state.referenceExternalTransactionId;
  }
  get referenceTransactionId(): string | null {
    return this.state.referenceTransactionId;
  }
  get status(): WagerTransactionStatus {
    return this.state.status;
  }
  get failureCode(): FailureCode | null {
    return this.state.failureCode;
  }
  get resultDetails(): ResultDetails | null {
    return this.state.resultDetails;
  }
  get resultBalance(): Money | null {
    return this.state.resultBalance;
  }
  get correlationId(): string {
    return this.state.correlationId;
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get createdAt(): Date {
    return this.state.createdAt;
  }
  get processedAt(): Date | null {
    return this.state.processedAt;
  }

  isTerminal(): boolean {
    return isTerminal(this.state.status);
  }

  /** Same idempotency payload: a replay. A different one under the same key is a conflict. */
  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  /** `PENDING` or `PENDING_REFERENCE` to `PROCESSED`, with the balance snapshot. */
  markProcessed(
    props: Decided & { readonly referenceTransactionId?: string },
  ): void {
    this.transition(WagerTransactionStatus.Processed);
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: props.referenceTransactionId ?? null,
      resultDetails: props.details ?? null,
      resultBalance: props.balance,
      processedAt: props.at,
    };
  }

  /** `PENDING` or `PENDING_REFERENCE` to `REJECTED`, final for this external ID. */
  markRejected(props: Decided & { readonly failureCode: RejectionCode }): void {
    if ((props.failureCode as FailureCode) === 'PROCESSING_FAILED') {
      throw new InvariantViolationError(
        'PROCESSING_FAILED marks FAILED; use markFailed()',
      );
    }
    this.transition(WagerTransactionStatus.Rejected);
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Rejected,
      failureCode: props.failureCode,
      resultDetails: props.details ?? null,
      resultBalance: props.balance,
      processedAt: props.at,
    };
  }

  /**
   * `PENDING` to `PENDING_REFERENCE`. Returns the delay in milliseconds until
   * the first worker attempt; the repository turns it into a time with the
   * database clock.
   */
  waitForReference(random?: RandomSource): number {
    if (this.state.status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransitionError(
        this.state.status,
        WagerTransactionStatus.PendingReference,
      );
    }
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.PendingReference,
    };
    return backoffDelay(1, REFERENCE_BACKOFF, random);
  }

  /**
   * `PENDING_REFERENCE` to itself after a worker attempt that still waits.
   * Counts the attempt and returns the delay until the next one.
   */
  reschedule(random?: RandomSource): number {
    if (this.state.status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransitionError(
        this.state.status,
        WagerTransactionStatus.PendingReference,
      );
    }
    const attempts = this.state.attempts + 1;
    this.state = { ...this.state, attempts };
    return backoffDelay(attempts, REFERENCE_BACKOFF, random);
  }

  /** `PENDING_REFERENCE` to `FAILED`: the final attempt at the TTL threw. */
  markFailed(at: Date): void {
    if (this.state.status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransitionError(
        this.state.status,
        WagerTransactionStatus.Failed,
      );
    }
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Failed,
      failureCode: 'PROCESSING_FAILED',
      processedAt: at,
    };
  }

  toState(): WagerTransactionState {
    return { ...this.state };
  }

  private transition(to: WagerTransactionStatus): void {
    if (!canTransition(this.state.status, to)) {
      throw new InvalidTransitionError(this.state.status, to);
    }
  }
}

function assertAmount(kind: WagerTransactionKind, money: Money): void {
  const valid = allowsZeroAmount(kind)
    ? !money.isNegative()
    : money.isPositive();
  if (!valid) {
    throw new InvariantViolationError(
      `${kind} amount must be ${allowsZeroAmount(kind) ? 'non-negative' : 'positive'}`,
    );
  }
}
