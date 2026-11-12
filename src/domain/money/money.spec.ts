import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../shared/domain-error.js';
import { MONEY_CEILING, Money } from './money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['exponent notation', '1e3'],
    ['exponent with decimals', '1.00e2'],
    ['the empty string', ''],
    ['no decimals', '25'],
    ['one decimal', '25.5'],
    ['three decimals (no rounding)', '1.005'],
    ['a bare point', '25.'],
    ['a missing integer part', '.50'],
    ['leading zeros', '025.00'],
    ['a leading plus', '+25.00'],
    ['negative zero', '-0.00'],
    ['leading whitespace', ' 25.00'],
    ['trailing whitespace', '25.00 '],
    ['a thousands separator', '1,000.00'],
    ['a decimal comma', '25,00'],
    ['more than 18 integer digits', '1234567890123456789.00'],
    ['an overlong string', `${'9'.repeat(40)}.00`],
  ])('rejects %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejects a non-string amount', () => {
    const props = { amount: 25 as unknown as string, currency: 'BRL' };
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  it.each(['brl', 'BR', 'BRLX', '', ' BRL', 'B1L'])(
    'rejects the currency %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  it('parses zero, cents, negatives, and the ceiling', () => {
    expect(brl('0.00').minor).toBe(0n);
    expect(brl('0.05').minor).toBe(5n);
    expect(brl('-0.05').minor).toBe(-5n);
    expect(brl('25.00').minor).toBe(2500n);
    expect(brl('999999999999.99').minor).toBe(MONEY_CEILING);
    expect(brl('999999999999999999.99').minor).toBe(
      99_999_999_999_999_999_999n,
    );
  });
});

describe('Money arithmetic', () => {
  it('adds 0.10 and 0.20 to exactly 0.30', () => {
    expect(brl('0.10').add(brl('0.20')).toProps()).toEqual({
      amount: '0.30',
      currency: 'BRL',
    });
  });

  it('subtracts, negates, and compares', () => {
    expect(brl('10.00').subtract(brl('25.50')).toProps().amount).toBe('-15.50');
    expect(brl('25.50').negate().toProps().amount).toBe('-25.50');
    expect(brl('0.00').negate().toProps().amount).toBe('0.00');
    expect(brl('1.00').compare(brl('2.00'))).toBe(-1);
    expect(brl('2.00').compare(brl('2.00'))).toBe(0);
    expect(brl('3.00').compare(brl('2.00'))).toBe(1);
    expect(brl('2.00').equals(brl('2.00'))).toBe(true);
  });

  it('is immutable', () => {
    const a = brl('1.00');
    a.add(brl('1.00'));
    a.negate();
    expect(a.toProps().amount).toBe('1.00');
  });

  it('reports sign, zero, and the ceiling', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
    expect(brl('999999999999.99').exceedsCeiling()).toBe(false);
    expect(brl('1000000000000.00').exceedsCeiling()).toBe(true);
  });

  it('throws on arithmetic and comparison across currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').compare(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').equals(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money serialization', () => {
  it.each([
    '0.00',
    '0.01',
    '0.10',
    '1.00',
    '-0.01',
    '-123.45',
    '999999999999.99',
  ])('round-trips %s through toProps', (amount) => {
    const props = { amount, currency: 'BRL' };
    expect(Money.from(props).toProps()).toEqual(props);
    expect(
      Money.from(Money.from(props).toProps()).equals(Money.from(props)),
    ).toBe(true);
  });

  it('formats minor units with two places', () => {
    expect(Money.ofMinor(7n, 'USD').toProps()).toEqual({
      amount: '0.07',
      currency: 'USD',
    });
    expect(Money.ofMinor(-12_345n, 'USD').toString()).toBe('-123.45 USD');
    expect(Money.zero('EUR').toProps()).toEqual({
      amount: '0.00',
      currency: 'EUR',
    });
  });

  it('serializes to JSON as MoneyProps, never as a number', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  it('rejects an invalid currency in ofMinor', () => {
    expect(() => Money.ofMinor(1n, 'brl')).toThrow(InvalidMoneyError);
  });
});
