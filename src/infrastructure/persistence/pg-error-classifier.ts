import {
  ContentionError,
  IdentityRaceError,
  OutageError,
  WalletAlreadyExists,
} from '../../application/errors.js';

/** SQLSTATEs of the Contention class (§10): retryable, never an outage. */
const CONTENTION_STATES: Readonly<Record<string, string>> = {
  '55P03': 'lock timeout',
  '40P01': 'deadlock',
  '40001': 'serialization failure',
  '57014': 'statement timeout',
  '25P04': 'transaction timeout',
};

/** Single SQLSTATEs of the Outage class; whole classes `08` and `53` are outages too. */
const OUTAGE_STATES: Readonly<Record<string, string>> = {
  '57P01': 'admin shutdown',
  '57P02': 'crash shutdown',
  '57P03': 'cannot connect now',
};

const OUTAGE_CLASSES: Readonly<Record<string, string>> = {
  '08': 'connection exception',
  '53': 'insufficient resources',
};

/** Socket errors of the driver: the server is unreachable or went away. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/** The unique constraints that mean another operation committed first. */
const UNIQUE_RACES: Readonly<
  Record<string, (cause: Error) => IdentityRaceError | WalletAlreadyExists>
> = {
  wager_transactions_provider_id_idempotency_key_key: (cause) =>
    new IdentityRaceError('idempotency_key', { cause }),
  wager_transactions_provider_id_external_transaction_id_key: (cause) =>
    new IdentityRaceError('external_transaction_id', { cause }),
  inbox_pkey: (cause) => new IdentityRaceError('inbox', { cause }),
  wallets_player_id_currency_key: (cause) =>
    new WalletAlreadyExists(undefined, { cause }),
};

type DriverErrorShape = {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
};

function field(error: DriverErrorShape, name: keyof DriverErrorShape): string {
  const value = error[name];
  return typeof value === 'string' ? value : '';
}

/** `pg-pool` reports an acquire timeout only through its message. */
function isPoolAcquireTimeout(message: string): boolean {
  return message.includes('timeout exceeded when trying to connect');
}

/** The driver lost the connection without a SQLSTATE. */
function isConnectionLoss(message: string): boolean {
  return (
    message.includes('Connection terminated') ||
    message.includes('Client has encountered a connection error')
  );
}

/**
 * Maps a database error to its class (§10): `ContentionError`, `OutageError`,
 * an identity race, or `WalletAlreadyExists`. Anything else is Unexpected and
 * is returned unchanged. Works on MikroORM `DriverException`s and raw `pg`
 * errors, which share `code` (the SQLSTATE) and `constraint`.
 */
export function classifyPgError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const shape = error as DriverErrorShape;
  const code = field(shape, 'code');
  const message = field(shape, 'message');

  const contention = CONTENTION_STATES[code];
  if (contention !== undefined) {
    return new ContentionError(contention, { cause: error });
  }
  if (isPoolAcquireTimeout(message)) {
    return new ContentionError('no free pooled connection', { cause: error });
  }

  const outage = OUTAGE_STATES[code] ?? OUTAGE_CLASSES[code.slice(0, 2)];
  if (outage !== undefined && /^[0-9A-Z]{5}$/.test(code)) {
    return new OutageError('postgres', outage, { cause: error });
  }
  if (NETWORK_CODES.has(code) || isConnectionLoss(message)) {
    return new OutageError('postgres', code || 'connection lost', {
      cause: error,
    });
  }

  if (code === '23505') {
    const race = UNIQUE_RACES[field(shape, 'constraint')];
    if (race !== undefined) return race(error);
  }
  return error;
}
