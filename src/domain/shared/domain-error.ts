export type DomainErrorCode =
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_TRANSITION'
  | 'INVARIANT_VIOLATION';

/**
 * A rule of the domain model was broken. Business rejections are not errors:
 * `settle()` returns them as decisions. A `DomainError` means the caller passed
 * a value or asked for a change the model never allows.
 */
export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A money amount or currency outside the strict grammar. */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

/** Arithmetic or comparison between two different currencies. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** A lifecycle change that the state machine does not allow. */
export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION';

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid transition from ${from} to ${to}`);
  }
}

/** Any other broken invariant, such as a negative balance or an unbalanced entry. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string) {
    super(message);
  }
}
