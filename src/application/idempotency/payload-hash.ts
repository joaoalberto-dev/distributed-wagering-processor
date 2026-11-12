import { createHash } from 'node:crypto';

/** The fields the payload hash covers (§8): the validated operation, without the key or any envelope field. */
export type HashedOperation = {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: { readonly amount: string; readonly currency: string };
  /** Absent and `undefined` hash the same: the field is omitted. */
  readonly referenceExternalTransactionId?: string | undefined;
};

/** The label of the algorithm below, stored and compared as part of the hash. */
const VERSION = 'v1';

type Canonical = string | { readonly [key: string]: Canonical };

/**
 * RFC 8785 canonical JSON for a tree of strings: keys sorted recursively,
 * then `JSON.stringify`. An absent (`undefined`) field is omitted; an
 * explicit `null`, or any value that is not a string or an object, is
 * refused, because the contract never lets one through.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'));
}

function canonicalize(value: unknown, path: string): Canonical {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `${path}: only strings and objects are hashed, got ${value === null ? 'null' : typeof value}`,
    );
  }
  const sorted: Record<string, Canonical> = {};
  for (const key of Object.keys(value).sort()) {
    const field: unknown = (value as Record<string, unknown>)[key];
    if (field !== undefined)
      sorted[key] = canonicalize(field, `${path}.${key}`);
  }
  return sorted;
}

/**
 * `v1:<hex SHA-256>` of the canonical operation (§8). Only the listed fields
 * are hashed, so the same operation hashes the same over HTTP and SQS.
 */
export function payloadHash(operation: HashedOperation): string {
  const hashed = {
    providerId: operation.providerId,
    externalTransactionId: operation.externalTransactionId,
    playerId: operation.playerId,
    walletId: operation.walletId,
    roundId: operation.roundId,
    gameId: operation.gameId,
    kind: operation.kind,
    money: {
      amount: operation.money.amount,
      currency: operation.money.currency,
    },
    referenceExternalTransactionId: operation.referenceExternalTransactionId,
  };
  const digest = createHash('sha256')
    .update(canonicalJson(hashed), 'utf8')
    .digest('hex');
  return `${VERSION}:${digest}`;
}
