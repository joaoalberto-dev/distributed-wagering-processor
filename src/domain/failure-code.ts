/**
 * The persisted failure codes: the `failure_code` of a `REJECTED` or `FAILED`
 * transaction. Codes that are never persisted (validation, identity conflicts,
 * an unknown wallet) belong to the application.
 */
export const FAILURE_CODES = [
  'WALLET_PLAYER_MISMATCH',
  'CURRENCY_MISMATCH',
  'REFERENCE_MISMATCH',
  'REFERENCE_INVALID',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED',
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'BALANCE_LIMIT_EXCEEDED',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_READY',
  'PROCESSING_FAILED',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** The codes of a `REJECTED` transaction; `PROCESSING_FAILED` marks `FAILED`. */
export type RejectionCode = Exclude<FailureCode, 'PROCESSING_FAILED'>;
