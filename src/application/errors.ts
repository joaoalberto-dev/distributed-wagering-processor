/**
 * Errors the application raises or receives from its adapters. Business
 * rejections are not errors: they are persisted results.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** D1: the wallet does not exist. Not persisted. */
export class WalletNotFound extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`wallet ${walletId} does not exist`);
  }
}

/**
 * A wallet already exists for this player and currency. The persistence
 * classifier raises it without the ID; the use case re-reads and fills it in.
 */
export class WalletAlreadyExists extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly walletId?: string,
    options?: ErrorOptions,
  ) {
    super('a wallet already exists for this player and currency', options);
  }
}

/** The idempotency key was already used with another payload. */
export class IdempotencyKeyConflict extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor() {
    super('the idempotency key was already used with another payload');
  }
}

/** The external transaction ID was already used with another payload or key. */
export class ExternalTransactionIdConflict extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';

  constructor() {
    super(
      'the external transaction ID was already used with another operation',
    );
  }
}

/** An SQS envelope `messageId` was reused for a different operation. */
export class MessageIdConflict extends ApplicationError {
  readonly code = 'MESSAGE_ID_CONFLICT';

  constructor(readonly messageId: string) {
    super(`message ${messageId} was already received with another operation`);
  }
}

export type IdentityConstraint =
  | 'idempotency_key'
  | 'external_transaction_id'
  | 'inbox';

/**
 * A unique identity was taken by a concurrent commit. The use case rolls
 * back, re-reads once, and decides between a replay and a conflict.
 */
export class IdentityRaceError extends ApplicationError {
  readonly code = 'IDENTITY_RACE';

  constructor(
    readonly constraint: IdentityConstraint,
    options?: ErrorOptions,
  ) {
    super(`another operation committed the same ${constraint} first`, options);
  }
}

export type ValidationIssue = {
  readonly path: string;
  readonly message: string;
};

/** The input contract (V1–V7) failed. Not persisted. */
export class ValidationFailed extends ApplicationError {
  readonly code = 'VALIDATION_FAILED';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super('the request does not match the contract');
  }
}

/**
 * Lock, statement, or transaction timeout, deadlock, serialization failure,
 * or no free pooled connection: retryable, and never a reason to open a circuit.
 */
export class ContentionError extends ApplicationError {
  readonly code = 'CONTENTION';

  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`contention: ${reason}`, options);
  }
}

/** A dependency is unreachable or shutting down; the circuits record only these. */
export class OutageError extends ApplicationError {
  readonly code = 'OUTAGE';

  constructor(
    readonly dependency: 'postgres' | 'sqs',
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`${dependency} outage: ${reason}`, options);
  }
}

/** A ledger cursor this API did not issue. Restart paging without one. */
export class InvalidCursor extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('the cursor is not valid; restart paging without one');
  }
}
