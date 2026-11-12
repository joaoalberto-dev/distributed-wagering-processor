export const WagerTransactionStatus = {
  /** Accepted and not yet decided. Exists only in memory, never persisted. */
  Pending: 'PENDING',
  /** Waiting for the referenced transaction. */
  PendingReference: 'PENDING_REFERENCE',
  Processed: 'PROCESSED',
  Rejected: 'REJECTED',
  /** The final attempt at the reference TTL threw an unexpected error. */
  Failed: 'FAILED',
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/**
 * The allowed edges. Leaving `PENDING` is the insert of the row; the edges out
 * of `PENDING_REFERENCE` are the persisted updates the database trigger allows.
 * Terminal statuses have no edges.
 */
const EDGES: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  PENDING: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE'],
  PENDING_REFERENCE: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

export function canTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): boolean {
  return EDGES[from].includes(to);
}

export function isTerminal(status: WagerTransactionStatus): boolean {
  return EDGES[status].length === 0;
}
