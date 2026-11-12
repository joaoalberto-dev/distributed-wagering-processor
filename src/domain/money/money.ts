import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../shared/domain-error.js';

/** The wire and storage form of money: a decimal string with two places. */
export type MoneyProps = {
  readonly amount: string;
  readonly currency: string;
};

/** The business ceiling, 999,999,999,999.99, in minor units. */
export const MONEY_CEILING = 99_999_999_999_999n;

const AMOUNT = /^-?(0|[1-9][0-9]{0,17})\.[0-9]{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
// "-", 18 integer digits, ".", 2 decimals.
const MAX_AMOUNT_LENGTH = 22;

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError('currency must be three uppercase letters');
  }
}

/**
 * An exact, immutable amount in BigInt minor units (cents) of one currency.
 *
 * `Money` may be negative or above the ceiling, because `negate()` and the
 * reconciliation of corrupted data need that. The input contract adds the
 * non-negative rule and the ceiling, and `Wallet` keeps balances in range.
 */
export class Money {
  private constructor(
    /** The amount in minor units. Never leaves the domain. */
    readonly minor: bigint,
    readonly currency: string,
  ) {}

  /** Parses the strict decimal grammar; nothing is rounded or normalized. */
  static from(props: MoneyProps): Money {
    const amount: unknown = props.amount;
    if (
      typeof amount !== 'string' ||
      amount.length > MAX_AMOUNT_LENGTH ||
      !AMOUNT.test(amount) ||
      amount === '-0.00'
    ) {
      throw new InvalidMoneyError(
        'amount must be a decimal string with exactly two places',
      );
    }
    assertCurrency(props.currency);
    const negative = amount.startsWith('-');
    const digits = (negative ? amount.slice(1) : amount).replace('.', '');
    const minor = BigInt(digits);
    return new Money(negative ? -minor : minor, props.currency);
  }

  static ofMinor(minor: bigint, currency: string): Money {
    if (typeof minor !== 'bigint') {
      throw new InvalidMoneyError('minor units must be a bigint');
    }
    assertCurrency(currency);
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  /** -1, 0, or 1. Throws across currencies. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    return this.minor > other.minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  exceedsCeiling(): boolean {
    return this.minor > MONEY_CEILING;
  }

  toProps(): MoneyProps {
    const magnitude = (this.minor < 0n ? -this.minor : this.minor)
      .toString()
      .padStart(3, '0');
    const sign = this.minor < 0n ? '-' : '';
    return {
      amount: `${sign}${magnitude.slice(0, -2)}.${magnitude.slice(-2)}`,
      currency: this.currency,
    };
  }

  toJSON(): MoneyProps {
    return this.toProps();
  }

  toString(): string {
    const { amount, currency } = this.toProps();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
