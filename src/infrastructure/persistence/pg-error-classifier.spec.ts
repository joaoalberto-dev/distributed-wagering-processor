import { describe, expect, it } from 'bun:test';
import {
  ContentionError,
  IdentityRaceError,
  OutageError,
  WalletAlreadyExists,
} from '../../application/errors.js';
import { classifyPgError } from './pg-error-classifier.js';

function pgError(
  code: string,
  extra: { constraint?: string; message?: string } = {},
): Error {
  return Object.assign(new Error(extra.message ?? `error ${code}`), {
    code,
    ...extra,
  });
}

describe('classifyPgError', () => {
  it.each([
    ['55P03', 'lock timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'serialization failure'],
    ['57014', 'statement timeout'],
    ['25P04', 'transaction timeout'],
  ])('classifies %s as contention (%s)', (code, reason) => {
    const error = pgError(code);
    const classified = classifyPgError(error);
    expect(classified).toBeInstanceOf(ContentionError);
    expect((classified as ContentionError).reason).toBe(reason);
    expect((classified as ContentionError).cause).toBe(error);
  });

  it('classifies a pool acquire timeout as contention', () => {
    const classified = classifyPgError(
      new Error('timeout exceeded when trying to connect'),
    );
    expect(classified).toBeInstanceOf(ContentionError);
  });

  it.each([
    ['08006', 'connection exception'],
    ['08001', 'connection exception'],
    ['53300', 'insufficient resources'],
    ['53100', 'insufficient resources'],
    ['57P01', 'admin shutdown'],
    ['57P02', 'crash shutdown'],
    ['57P03', 'cannot connect now'],
  ])('classifies %s as a postgres outage (%s)', (code, reason) => {
    const classified = classifyPgError(pgError(code));
    expect(classified).toBeInstanceOf(OutageError);
    expect((classified as OutageError).dependency).toBe('postgres');
    expect((classified as OutageError).reason).toBe(reason);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])(
    'classifies the socket error %s as an outage',
    (code) => {
      expect(classifyPgError(pgError(code))).toBeInstanceOf(OutageError);
    },
  );

  it('classifies a connection terminated without a SQLSTATE as an outage', () => {
    expect(
      classifyPgError(new Error('Connection terminated unexpectedly')),
    ).toBeInstanceOf(OutageError);
  });

  it.each([
    ['wager_transactions_provider_id_idempotency_key_key', 'idempotency_key'],
    [
      'wager_transactions_provider_id_external_transaction_id_key',
      'external_transaction_id',
    ],
    ['inbox_pkey', 'inbox'],
  ] as const)(
    'maps a violation of %s to an identity race',
    (constraint, expected) => {
      const classified = classifyPgError(pgError('23505', { constraint }));
      expect(classified).toBeInstanceOf(IdentityRaceError);
      expect((classified as IdentityRaceError).constraint).toBe(expected);
    },
  );

  it('maps a violation of wallets_player_id_currency_key to WalletAlreadyExists', () => {
    const classified = classifyPgError(
      pgError('23505', { constraint: 'wallets_player_id_currency_key' }),
    );
    expect(classified).toBeInstanceOf(WalletAlreadyExists);
    expect((classified as WalletAlreadyExists).walletId).toBeUndefined();
  });

  it.each([
    'wallet_ledger_entries_wallet_id_wallet_version_key',
    'wallet_ledger_entries_transaction_id_key',
    'wager_transactions_reference_transaction_id_key',
  ])('leaves a violation of %s unexpected', (constraint) => {
    const error = pgError('23505', { constraint });
    expect(classifyPgError(error)).toBe(error);
  });

  it.each(['23514', '23503', '23000', '42501', 'P0001'])(
    'leaves %s unexpected',
    (code) => {
      const error = pgError(code);
      expect(classifyPgError(error)).toBe(error);
    },
  );

  it('returns non-errors and errors without a code unchanged', () => {
    const plain = new Error('something else');
    expect(classifyPgError(plain)).toBe(plain);
    expect(classifyPgError('text')).toBe('text');
  });
});
