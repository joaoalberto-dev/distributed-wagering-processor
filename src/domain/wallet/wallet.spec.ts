import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { Money } from '../money/money.js';
import {
  CurrencyMismatchError,
  InvariantViolationError,
} from '../shared/domain-error.js';
import { Wallet } from './wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-12T10:00:00.000Z');
const later = new Date('2026-11-12T10:05:00.000Z');
const debit = (amount: string) => ({
  direction: LedgerDirection.Debit,
  amount: brl(amount),
});
const credit = (amount: string) => ({
  direction: LedgerDirection.Credit,
  amount: brl(amount),
});

function openWallet(initial = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    at,
  });
}

describe('Wallet.open', () => {
  it('opens at version 1 with the initial balance and its currency', () => {
    const wallet = openWallet('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toProps()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toBe(at);
    expect(wallet.updatedAt).toBe(at);
  });

  it('opens at zero, also at version 1', () => {
    const wallet = openWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('refuses a negative or above-ceiling opening balance', () => {
    expect(() => openWallet('-0.01')).toThrow(InvariantViolationError);
    expect(() => openWallet('1000000000000.00')).toThrow(
      InvariantViolationError,
    );
    expect(openWallet('999999999999.99').balance.exceedsCeiling()).toBe(false);
  });
});

describe('Wallet.apply', () => {
  it('debits and credits, returning before, after, and the new version', () => {
    const wallet = openWallet('100.00');

    const bet = wallet.apply(debit('25.00'), later);
    expect(bet.balanceBefore.toProps().amount).toBe('100.00');
    expect(bet.balanceAfter.toProps().amount).toBe('75.00');
    expect(bet.version).toBe(2);

    const win = wallet.apply(credit('50.00'), later);
    expect(win.balanceBefore.toProps().amount).toBe('75.00');
    expect(win.balanceAfter.toProps().amount).toBe('125.00');
    expect(win.version).toBe(3);

    expect(wallet.balance.toProps().amount).toBe('125.00');
    expect(wallet.version).toBe(3);
    expect(wallet.updatedAt).toBe(later);
  });

  it('allows a debit down to exactly zero', () => {
    const wallet = openWallet('25.00');
    expect(wallet.apply(debit('25.00'), later).balanceAfter.isZero()).toBe(
      true,
    );
  });

  it('throws on a debit below zero and leaves the wallet unchanged', () => {
    const wallet = openWallet('10.00');
    expect(wallet.check(debit('10.01'))).toBe('BELOW_ZERO');
    expect(() => wallet.apply(debit('10.01'), later)).toThrow(
      InvariantViolationError,
    );
    expect(wallet.balance.toProps().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(at);
  });

  it('throws on a credit above the ceiling and allows one up to it', () => {
    const wallet = openWallet('999999999999.00');
    expect(wallet.check(credit('1.00'))).toBe('ABOVE_CEILING');
    expect(() => wallet.apply(credit('1.00'), later)).toThrow(
      InvariantViolationError,
    );
    expect(wallet.version).toBe(1);
    expect(
      wallet.apply(credit('0.99'), later).balanceAfter.exceedsCeiling(),
    ).toBe(false);
  });

  it('throws on a currency mismatch without changing the wallet', () => {
    const wallet = openWallet('100.00');
    const usd = {
      direction: LedgerDirection.Credit,
      amount: Money.from({ amount: '1.00', currency: 'USD' }),
    };
    expect(() => wallet.check(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.apply(usd, later)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('refuses a zero or negative effect amount', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.apply(credit('0.00'), later)).toThrow(
      InvariantViolationError,
    );
    expect(() => wallet.apply(debit('-1.00'), later)).toThrow(
      InvariantViolationError,
    );
    expect(wallet.version).toBe(1);
  });

  it('does not change the version when nothing is applied', () => {
    const wallet = openWallet('100.00');
    wallet.check(debit('1.00'));
    wallet.belongsTo('player-1');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet queries and rehydration', () => {
  it('belongs only to its player', () => {
    const wallet = openWallet();
    expect(wallet.belongsTo('player-1')).toBe(true);
    expect(wallet.belongsTo('player-2')).toBe(false);
  });

  it('rehydrates persisted state as is', () => {
    const state = {
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: at,
      updatedAt: later,
    };
    const wallet = Wallet.rehydrate(state);
    expect(wallet.toState()).toEqual(state);
    wallet.apply(credit('1.00'), later);
    expect(wallet.version).toBe(18);
    expect(state.version).toBe(17);
  });
});
