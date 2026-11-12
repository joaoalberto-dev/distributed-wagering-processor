import { describe, expect, it } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerQuery,
  openWalletBody,
  walletIdParam,
} from './wallet.schemas.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

describe('openWalletBody', () => {
  it('accepts a player and an initial balance, zero included', () => {
    for (const amount of ['0.00', '1000.00']) {
      expect(
        openWalletBody.safeParse({
          playerId: PLAYER,
          initialBalance: { amount, currency: 'BRL' },
        }).success,
      ).toBe(true);
    }
  });
  it('rejects a missing balance, a negative one, an unknown field, and a bad player', () => {
    const balance = { amount: '1.00', currency: 'BRL' };
    for (const body of [
      { playerId: PLAYER },
      {
        playerId: PLAYER,
        initialBalance: { amount: '-1.00', currency: 'BRL' },
      },
      { playerId: PLAYER, initialBalance: balance, walletId: PLAYER },
      { playerId: 'player-1', initialBalance: balance },
      { playerId: PLAYER, initialBalance: null },
    ]) {
      expect(openWalletBody.safeParse(body).success).toBe(false);
    }
  });
});

describe('walletIdParam', () => {
  it('accepts a lowercase UUID and rejects anything else', () => {
    expect(walletIdParam.safeParse(PLAYER).success).toBe(true);
    expect(walletIdParam.safeParse('wallet-1').success).toBe(false);
  });
});

describe('ledgerQuery', () => {
  it('defaults the limit to 50 and coerces it from the query string', () => {
    expect(ledgerQuery.parse({})).toEqual({ limit: 50 });
    expect(ledgerQuery.parse({ limit: '200', cursor: 'abc' })).toEqual({
      limit: 200,
      cursor: 'abc',
    });
  });
  it('rejects a limit outside 1–200, a fraction, and unknown parameters', () => {
    for (const query of [
      { limit: '0' },
      { limit: '201' },
      { limit: '500' },
      { limit: '1.5' },
      { limit: 'ten' },
      { offset: '10' },
    ]) {
      expect(ledgerQuery.safeParse(query).success).toBe(false);
    }
  });
});

describe('ledger cursor', () => {
  it('round-trips the last version as base64url JSON', () => {
    const cursor = encodeLedgerCursor(50);
    expect(cursor).toBe(Buffer.from('{"v":50}').toString('base64url'));
    expect(decodeLedgerCursor(cursor)).toBe(50);
  });
  it('rejects garbage, other JSON, and non-positive versions', () => {
    const encode = (value: string) => Buffer.from(value).toString('base64url');
    for (const cursor of [
      'not a cursor!',
      'garbage',
      encode('{"v":"50"}'),
      encode('{"v":0}'),
      encode('{"v":1,"x":2}'),
      encode('[]'),
    ]) {
      expect(decodeLedgerCursor(cursor)).toBeNull();
    }
  });
});
