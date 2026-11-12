import { z } from 'zod';

/**
 * Formats shared by the HTTP and SQS contracts (§5, V2 and V3; §8, Formats).
 * They validate shape only; the domain still guards its own invariants.
 */

/** `providerId`, `externalTransactionId`, `roundId`, `gameId`, envelope `messageId`, `X-Correlation-Id`. */
export const externalId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'must be 1–128 of [A-Za-z0-9._:-]');

/** `playerId`, `walletId`, and server IDs: a canonical lowercase UUID. */
export const lowercaseUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'must be a lowercase UUID',
  );

/** Non-negative, two decimals, at most the ceiling of 999,999,999,999.99 (V3). */
export const contractAmount = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/,
    'must be a non-negative decimal string with two places, at most 999999999999.99',
  );

export const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be three uppercase letters');

/** `MoneyProps` on the wire: `{ amount: "25.00", currency: "BRL" }`. */
export const money = z.strictObject({ amount: contractAmount, currency });

export type MoneyInput = z.infer<typeof money>;

/** `Idempotency-Key` and `data.idempotencyKey`: 1–255 printable ASCII characters, no space. */
export const idempotencyKey = z
  .string()
  .regex(/^[\x21-\x7E]{1,255}$/, 'must be 1–255 printable ASCII characters');
