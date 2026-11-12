import { z } from 'zod';
import { lowercaseUuid, money } from './primitives.js';

/** `POST /wallets`; `initialBalance` is required and may be `0.00`. */
export const openWalletBody = z.strictObject({
  playerId: lowercaseUuid,
  initialBalance: money,
});

export type OpenWalletBody = z.infer<typeof openWalletBody>;

/** `:walletId` in every wallet route. */
export const walletIdParam = lowercaseUuid;

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

/**
 * `GET /wallets/:walletId/ledger?cursor&limit`. The cursor is checked only
 * for size here; `decodeLedgerCursor` decides whether it is one of ours.
 */
export const ledgerQuery = z.strictObject({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LEDGER_PAGE_MAX)
    .default(LEDGER_PAGE_DEFAULT),
});

export type LedgerQuery = z.infer<typeof ledgerQuery>;

const cursorPayload = z.strictObject({ v: z.number().int().positive() });

/** The opaque ledger cursor: base64url of `{"v": <last wallet_version>}`. */
export function encodeLedgerCursor(lastVersion: number): string {
  return Buffer.from(JSON.stringify({ v: lastVersion })).toString('base64url');
}

/** The last version a cursor points after, or null when it is not a cursor this API issued. */
export function decodeLedgerCursor(cursor: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const json: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    const parsed = cursorPayload.safeParse(json);
    return parsed.success ? parsed.data.v : null;
  } catch {
    return null;
  }
}
