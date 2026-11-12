import { Money } from '../money/money.js';
import { InvariantViolationError } from '../shared/domain-error.js';
import { LedgerDirection } from './ledger-direction.js';

export type WalletLedgerEntryState = {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** The wallet version after this entry is applied. */
  readonly walletVersion: number;
  readonly createdAt: Date;
};

/** One immutable balance movement. It has no mutable fields and no transitions. */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(state: WalletLedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.amount = state.amount;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  /** Checks `amount > 0` and `balanceBefore ± amount = balanceAfter`. */
  static create(props: WalletLedgerEntryState): WalletLedgerEntry {
    if (!props.amount.isPositive()) {
      throw new InvariantViolationError('a ledger amount must be positive');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError(
        'a ledger wallet version must be a positive integer',
      );
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `unbalanced ${props.direction} entry: ${props.balanceBefore.toString()} and ${props.amount.toString()} do not give ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Rebuilds persisted state without re-validating it. */
  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** `balanceBefore ± amount === balanceAfter`, by direction. Throws across currencies. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.amount)
        : this.balanceBefore.add(this.amount);
    return expected.equals(this.balanceAfter);
  }

  toState(): WalletLedgerEntryState {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      amount: this.amount,
      balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter,
      walletVersion: this.walletVersion,
      createdAt: this.createdAt,
    };
  }
}
