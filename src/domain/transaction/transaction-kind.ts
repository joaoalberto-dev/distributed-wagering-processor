export const WagerTransactionKind = {
  /** Internal: the opening credit of a wallet. Never submitted. */
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

/** The kinds a provider may submit. */
export type SubmittableKind = Exclude<WagerTransactionKind, 'OPENING'>;

/**
 * How a kind moves the balance. `INVERSE` is the opposite of the referenced
 * transaction's ledger entry; `NONE` writes no entry and keeps the version.
 */
export type KindEffect = 'DEBIT' | 'CREDIT' | 'INVERSE' | 'NONE';

export const KIND_EFFECT: Readonly<Record<WagerTransactionKind, KindEffect>> = {
  OPENING: 'CREDIT',
  BET: 'DEBIT',
  WIN: 'CREDIT',
  LOSS: 'NONE',
  REFUND: 'CREDIT',
  ROLLBACK: 'INVERSE',
};

export type ReferenceRule = 'required' | 'optional' | 'forbidden';

/** Whether a kind carries `referenceExternalTransactionId` (V5). */
export const REFERENCE_RULE: Readonly<
  Record<WagerTransactionKind, ReferenceRule>
> = {
  OPENING: 'forbidden',
  BET: 'forbidden',
  WIN: 'optional',
  LOSS: 'optional',
  REFUND: 'required',
  ROLLBACK: 'required',
};

/** The kinds each kind may reference (D6). */
export const ALLOWED_REFERENCES: Readonly<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  OPENING: [],
  BET: [],
  WIN: ['BET'],
  LOSS: ['BET'],
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

/** `REFUND` and `ROLLBACK`: at most one of them succeeds per reference (D9). */
export function isReversal(kind: WagerTransactionKind): boolean {
  return kind === 'REFUND' || kind === 'ROLLBACK';
}

/**
 * Whether another kind may reference this one: `BET`, `WIN`, `REFUND`. When
 * such a transaction becomes terminal, its pending dependents are woken up.
 */
export function isReferenceable(kind: WagerTransactionKind): boolean {
  return Object.values(ALLOWED_REFERENCES).some((targets) =>
    targets.includes(kind),
  );
}

/** `LOSS` is informational and may be zero; every other kind is positive (V6). */
export function allowsZeroAmount(kind: WagerTransactionKind): boolean {
  return kind === 'LOSS';
}
