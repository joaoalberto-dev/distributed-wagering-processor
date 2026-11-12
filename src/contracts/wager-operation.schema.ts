import { z } from 'zod';
import {
  externalId,
  idempotencyKey,
  lowercaseUuid,
  money,
} from './primitives.js';

/** The kinds a provider may submit (V4: `OPENING` is internal). */
export const SUBMITTABLE_KINDS = [
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
] as const;

type Kind = (typeof SUBMITTABLE_KINDS)[number];

/** V5: whether a kind carries `referenceExternalTransactionId`. */
const REFERENCE_RULE: Readonly<
  Record<Kind, 'required' | 'optional' | 'forbidden'>
> = {
  BET: 'forbidden',
  WIN: 'optional',
  LOSS: 'optional',
  REFUND: 'required',
  ROLLBACK: 'required',
};

const kind = z.enum(SUBMITTABLE_KINDS, {
  error: `must be one of ${SUBMITTABLE_KINDS.join(', ')}`,
});

/** The fields of challenge §9 (§7, Request body); unknown fields are rejected (V1). */
const operationShape = {
  providerId: externalId,
  externalTransactionId: externalId,
  playerId: lowercaseUuid,
  walletId: lowercaseUuid,
  roundId: externalId,
  gameId: externalId,
  kind,
  money,
  referenceExternalTransactionId: externalId.optional(),
};

type OperationFields = {
  readonly externalTransactionId: string;
  readonly kind: Kind;
  readonly money: { readonly amount: string };
  readonly referenceExternalTransactionId?: string | undefined;
};

/** V5–V7, which depend on the kind. Field formats and V3 are checked by the shape. */
function checkKindRules(
  operation: OperationFields,
  ctx: z.core.$RefinementCtx<OperationFields>,
): void {
  const rule = REFERENCE_RULE[operation.kind];
  const reference = operation.referenceExternalTransactionId;
  const path = ['referenceExternalTransactionId'];
  if (rule === 'required' && reference === undefined) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `is required for ${operation.kind}`,
    });
  }
  if (rule === 'forbidden' && reference !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `is not allowed for ${operation.kind}`,
    });
  }
  if (
    reference !== undefined &&
    reference === operation.externalTransactionId
  ) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: 'must not reference the operation itself',
    });
  }
  if (operation.kind !== 'LOSS' && operation.money.amount === '0.00') {
    ctx.addIssue({
      code: 'custom',
      path: ['money', 'amount'],
      message: `must be positive for ${operation.kind}`,
    });
  }
}

/**
 * `POST /wagering/transactions` (§7), and the core of the SQS `data`: the
 * input contract V1–V7 (§5). An explicit `null` is never accepted, not even
 * for the optional reference.
 */
export const wagerOperation = z
  .strictObject(operationShape)
  .superRefine(checkKindRules);

export type WagerOperationBody = z.infer<typeof wagerOperation>;

/** The SQS envelope `data`: the operation plus the key the HTTP header would carry (§8). */
export const wagerOperationData = z
  .strictObject({ ...operationShape, idempotencyKey })
  .superRefine(checkKindRules);

export type WagerOperationData = z.infer<typeof wagerOperationData>;

/** The `Idempotency-Key` header; required. */
export const idempotencyKeyHeader = idempotencyKey;

/** `:transactionId`. */
export const transactionIdParam = lowercaseUuid;

/** `:providerId` and `:externalTransactionId` of the provider route. */
export const externalIdParam = externalId;
