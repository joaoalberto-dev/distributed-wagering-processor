export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

export type LedgerDirection =
  (typeof LedgerDirection)[keyof typeof LedgerDirection];

export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit
    ? LedgerDirection.Credit
    : LedgerDirection.Debit;
}
