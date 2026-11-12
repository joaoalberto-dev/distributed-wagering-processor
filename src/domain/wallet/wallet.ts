import { LedgerDirection } from '../ledger/ledger-direction.js';
import { Money } from '../money/money.js';
import {
  CurrencyMismatchError,
  InvariantViolationError,
} from '../shared/domain-error.js';

export type WalletState = {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** A movement of the balance: a positive amount in one direction. */
export type BalanceEffect = {
  readonly direction: LedgerDirection;
  readonly amount: Money;
};

export type AppliedEffect = {
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** The wallet version after the effect; the ledger entry's `walletVersion`. */
  readonly version: number;
};

export type EffectCheck = 'OK' | 'BELOW_ZERO' | 'ABOVE_CEILING';

/**
 * The aggregate root of a player's balance in one currency.
 *
 * The balance stays in `[0, ceiling]`. `version` starts at 1 and increases by
 * one each time the balance changes, and at no other time.
 */
export class Wallet {
  private constructor(private state: WalletState) {}

  /**
   * Opens a wallet at version 1. A positive opening balance is recorded by the
   * caller as an `OPENING` transaction with its `CREDIT` entry at version 1; a
   * zero opening has neither.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): Wallet {
    const { initialBalance } = props;
    if (initialBalance.isNegative() || initialBalance.exceedsCeiling()) {
      throw new InvariantViolationError(
        'opening balance must be between zero and the ceiling',
      );
    }
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: initialBalance.currency,
      balance: initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
  }

  /** Rebuilds persisted state without re-validating it. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get currency(): string {
    return this.state.currency;
  }

  get balance(): Money {
    return this.state.balance;
  }

  get version(): number {
    return this.state.version;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  belongsTo(playerId: string): boolean {
    return this.state.playerId === playerId;
  }

  /**
   * Whether the effect keeps the balance in range, without changing anything.
   * Throws on a currency mismatch or a non-positive amount, which no caller
   * should ever pass.
   */
  check(effect: BalanceEffect): EffectCheck {
    const after = this.balanceAfter(effect);
    if (after.isNegative()) return 'BELOW_ZERO';
    return after.exceedsCeiling() ? 'ABOVE_CEILING' : 'OK';
  }

  /** Moves the balance and bumps the version; throws if it would leave the range. */
  apply(effect: BalanceEffect, at: Date): AppliedEffect {
    const outcome = this.check(effect);
    if (outcome !== 'OK') {
      throw new InvariantViolationError(
        `wallet ${this.state.id}: effect would put the balance ${outcome === 'BELOW_ZERO' ? 'below zero' : 'above the ceiling'}`,
      );
    }
    const balanceBefore = this.state.balance;
    const balanceAfter = this.balanceAfter(effect);
    const version = this.state.version + 1;
    this.state = {
      ...this.state,
      balance: balanceAfter,
      version,
      updatedAt: at,
    };
    return { balanceBefore, balanceAfter, version };
  }

  toState(): WalletState {
    return { ...this.state };
  }

  private balanceAfter({ direction, amount }: BalanceEffect): Money {
    if (amount.currency !== this.state.currency) {
      throw new CurrencyMismatchError(this.state.currency, amount.currency);
    }
    if (!amount.isPositive()) {
      throw new InvariantViolationError('an effect amount must be positive');
    }
    return direction === LedgerDirection.Debit
      ? this.state.balance.subtract(amount)
      : this.state.balance.add(amount);
  }
}
