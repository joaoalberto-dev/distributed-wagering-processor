import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money.js';
import {
  CurrencyMismatchError,
  InvariantViolationError,
} from '../shared/domain-error.js';
import { LedgerDirection } from './ledger-direction.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function entry(
  direction: LedgerDirection,
  before: string,
  amount: string,
  after: string,
) {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction,
    amount: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    walletVersion: 2,
    createdAt: new Date('2026-11-12T10:00:00.000Z'),
  };
}

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced debit', () => {
    const created = WalletLedgerEntry.create(
      entry(LedgerDirection.Debit, '100.00', '25.00', '75.00'),
    );
    expect(created.isBalanced()).toBe(true);
    expect(created.balanceAfter.toProps().amount).toBe('75.00');
  });

  it('accepts a balanced credit', () => {
    const created = WalletLedgerEntry.create(
      entry(LedgerDirection.Credit, '75.00', '50.00', '125.00'),
    );
    expect(created.isBalanced()).toBe(true);
  });

  it('refuses an unbalanced debit', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entry(LedgerDirection.Debit, '100.00', '25.00', '125.00'),
      ),
    ).toThrow(InvariantViolationError);
  });

  it('refuses an unbalanced credit', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entry(LedgerDirection.Credit, '100.00', '25.00', '75.00'),
      ),
    ).toThrow(InvariantViolationError);
  });

  it('refuses a zero or negative amount', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entry(LedgerDirection.Credit, '10.00', '0.00', '10.00'),
      ),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create(
        entry(LedgerDirection.Debit, '10.00', '-1.00', '11.00'),
      ),
    ).toThrow(InvariantViolationError);
  });

  it('refuses a wallet version below 1', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...entry(LedgerDirection.Credit, '0.00', '10.00', '10.00'),
        walletVersion: 0,
      }),
    ).toThrow(InvariantViolationError);
  });

  it('refuses mixed currencies', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...entry(LedgerDirection.Credit, '0.00', '10.00', '10.00'),
        amount: Money.from({ amount: '10.00', currency: 'USD' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('is structurally immutable', () => {
    const created = WalletLedgerEntry.create(
      entry(LedgerDirection.Debit, '100.00', '25.00', '75.00'),
    );
    expect(Object.isFrozen(created)).toBe(true);
    expect(() => {
      (created as { walletVersion: number }).walletVersion = 3;
    }).toThrow(TypeError);
  });

  it('rehydrates without re-validating and round-trips its state', () => {
    const state = entry(LedgerDirection.Debit, '100.00', '25.00', '125.00');
    const rehydrated = WalletLedgerEntry.rehydrate(state);
    expect(rehydrated.isBalanced()).toBe(false);
    expect(rehydrated.toState()).toEqual(state);
  });
});
