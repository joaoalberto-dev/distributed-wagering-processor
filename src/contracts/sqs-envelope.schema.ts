import { z } from 'zod';
import { externalId } from './primitives.js';
import { wagerOperationData } from './wager-operation.schema.js';

/** The only envelope `type` the input queue accepts (challenge §10). */
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/**
 * The body of a message on `wager-transactions.fifo` (§8, SQS message
 * shape): an envelope around the HTTP body plus its idempotency key.
 * Unknown fields are rejected at both levels.
 */
export const sqsEnvelope = z.strictObject({
  messageId: externalId,
  type: z.literal(WAGER_MESSAGE_TYPE, {
    error: `must be ${WAGER_MESSAGE_TYPE}`,
  }),
  occurredAt: z.iso.datetime({ offset: true }),
  data: wagerOperationData,
});

export type SqsEnvelope = z.infer<typeof sqsEnvelope>;
