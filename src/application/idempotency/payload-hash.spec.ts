import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  type HashedOperation,
  payloadHash,
} from './payload-hash.js';

/** The §8 example operation. */
const OPERATION: HashedOperation = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payloadHash', () => {
  it('pins the v1 vector of the §8 example', () => {
    expect(canonicalJson(OPERATION)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(payloadHash(OPERATION)).toBe(
      'v1:629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344',
    );
  });

  it('does not depend on the order of the keys, nested ones included', () => {
    const reordered: HashedOperation = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(payloadHash(reordered)).toBe(payloadHash(OPERATION));
  });

  it('does not hash an absent optional field, and hashes a present one', () => {
    const win = { ...OPERATION, kind: 'WIN' };
    expect(
      payloadHash({
        ...win,
        referenceExternalTransactionId: undefined,
      } as never),
    ).toBe(payloadHash(win));
    expect(
      payloadHash({ ...win, referenceExternalTransactionId: 'transaction-1' }),
    ).not.toBe(payloadHash(win));
  });

  it('ignores fields outside the operation, such as the SQS idempotency key', () => {
    const withKey = {
      ...OPERATION,
      idempotencyKey: 'provider-a:transaction-123',
    };
    expect(payloadHash(withKey)).toBe(payloadHash(OPERATION));
  });

  it('changes with any hashed value', () => {
    expect(
      payloadHash({
        ...OPERATION,
        money: { amount: '25.01', currency: 'BRL' },
      }),
    ).not.toBe(payloadHash(OPERATION));
  });

  it('rejects an explicit null', () => {
    expect(() =>
      payloadHash({
        ...OPERATION,
        referenceExternalTransactionId: null,
      } as unknown as HashedOperation),
    ).toThrow(TypeError);
    expect(() => canonicalJson({ a: null })).toThrow(TypeError);
  });
});
