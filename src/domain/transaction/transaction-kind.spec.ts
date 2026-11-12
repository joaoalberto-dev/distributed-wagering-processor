import { describe, expect, it } from 'bun:test';
import {
  ALLOWED_REFERENCES,
  allowsZeroAmount,
  isReferenceable,
  isReversal,
  KIND_EFFECT,
  REFERENCE_RULE,
  WagerTransactionKind,
} from './transaction-kind.js';

const kinds = Object.values(WagerTransactionKind);

describe('transaction kind rules', () => {
  it('maps each kind to its balance effect', () => {
    expect(KIND_EFFECT).toEqual({
      OPENING: 'CREDIT',
      BET: 'DEBIT',
      WIN: 'CREDIT',
      LOSS: 'NONE',
      REFUND: 'CREDIT',
      ROLLBACK: 'INVERSE',
    });
  });

  it('requires, allows, or forbids a reference by kind', () => {
    expect(REFERENCE_RULE).toEqual({
      OPENING: 'forbidden',
      BET: 'forbidden',
      WIN: 'optional',
      LOSS: 'optional',
      REFUND: 'required',
      ROLLBACK: 'required',
    });
  });

  it('lets only kinds that may carry a reference reference something', () => {
    for (const kind of kinds) {
      expect(ALLOWED_REFERENCES[kind].length > 0).toBe(
        REFERENCE_RULE[kind] !== 'forbidden',
      );
    }
  });

  it('wakes dependents only of BET, WIN, and REFUND', () => {
    expect(kinds.filter(isReferenceable)).toEqual(['BET', 'WIN', 'REFUND']);
  });

  it('treats REFUND and ROLLBACK as reversals', () => {
    expect(kinds.filter(isReversal)).toEqual(['REFUND', 'ROLLBACK']);
  });

  it('allows a zero amount only for LOSS', () => {
    expect(kinds.filter(allowsZeroAmount)).toEqual(['LOSS']);
  });
});
