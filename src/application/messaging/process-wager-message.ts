import {
  ContentionError,
  ExternalTransactionIdConflict,
  IdempotencyKeyConflict,
  MessageIdConflict,
  OutageError,
  WalletNotFound,
} from '../errors.js';
import type { AppLogger } from '../ports/logger.js';
import type { RequestContext } from '../ports/request-context.js';
import type { Telemetry } from '../ports/telemetry.js';
import type {
  SubmitCommand,
  SubmitResult,
  WagerOperation,
} from '../wagering/submit-wager-transaction.js';

/** The inbox's consumer name (§8): one per logical consumer, not per instance. */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

/** A message from the input queue whose envelope passed the contract. */
export type WagerMessage = {
  /** The envelope `messageId`: the inbox identity, correlation, and causation. */
  readonly messageId: string;
  /** The SQS-assigned ID; logged only (§8). */
  readonly sqsMessageId: string;
  readonly idempotencyKey: string;
  readonly operation: WagerOperation;
};

/** Reasons a message is moved to the DLQ without waiting for a budget. */
export type PermanentReason =
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_ID_CONFLICT'
  | 'MESSAGE_ID_CONFLICT'
  | 'WALLET_NOT_FOUND';

/** The DLQ `failureReason` attribute (§6): a permanent reason or a spent budget. */
export type DlqReason =
  | PermanentReason
  | 'UNEXPECTED_ERROR'
  | 'RETRY_BUDGET_EXHAUSTED';

export type RetryClass = 'contention' | 'outage' | 'unexpected';

/**
 * What the consumer does with one delivery. A retry is decided against the
 * receive count by the adapter's retry policy: a backoff, or the DLQ once
 * the class's budget is spent.
 */
export type MessageOutcome =
  | {
      readonly kind: 'ack';
      readonly reason: 'processed' | 'replay' | 'duplicate';
    }
  | { readonly kind: 'dlq'; readonly reason: PermanentReason }
  | { readonly kind: 'retry'; readonly errorClass: RetryClass };

/** The submission use case, as this one needs it. */
export type WagerSubmitter = {
  execute(command: SubmitCommand): Promise<SubmitResult>;
};

/**
 * Processes one valid SQS message through the same use case as HTTP (§10,
 * §12) and classifies the result for the consumer. The inbox lookup, the
 * short replay transaction, and the inbox insert that inserts nothing all
 * happen inside `SubmitWagerTransaction`, which receives the delivery.
 *
 * Every committed result is acknowledged, a `REJECTED` or a
 * `PENDING_REFERENCE` included. Errors map to the error classes of §10.
 */
export class ProcessWagerMessage {
  constructor(
    private readonly submit: WagerSubmitter,
    private readonly telemetry: Telemetry,
    private readonly logger: AppLogger,
    private readonly context: RequestContext,
  ) {}

  execute(message: WagerMessage): Promise<MessageOutcome> {
    return this.context.run(
      {
        messageId: message.messageId,
        sqsMessageId: message.sqsMessageId,
        correlationId: message.messageId,
      },
      () => this.process(message),
    );
  }

  private async process(message: WagerMessage): Promise<MessageOutcome> {
    try {
      const result = await this.submit.execute({
        operation: message.operation,
        idempotencyKey: message.idempotencyKey,
        channel: 'sqs',
        correlationId: message.messageId,
        causationId: message.messageId,
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: message.messageId,
        },
      });
      if (result.duplicate) {
        this.telemetry.inboxDuplicate();
        return { kind: 'ack', reason: 'duplicate' };
      }
      return { kind: 'ack', reason: result.replay ? 'replay' : 'processed' };
    } catch (error) {
      return this.classify(error);
    }
  }

  private classify(error: unknown): MessageOutcome {
    if (error instanceof MessageIdConflict) {
      this.telemetry.messageIdConflict();
      this.logger.warn('message ID reused for another operation', {
        reason: error.code,
      });
      return { kind: 'dlq', reason: 'MESSAGE_ID_CONFLICT' };
    }
    if (error instanceof IdempotencyKeyConflict) {
      return { kind: 'dlq', reason: 'IDEMPOTENCY_KEY_CONFLICT' };
    }
    if (error instanceof ExternalTransactionIdConflict) {
      return { kind: 'dlq', reason: 'EXTERNAL_TRANSACTION_ID_CONFLICT' };
    }
    if (error instanceof WalletNotFound) {
      return { kind: 'dlq', reason: 'WALLET_NOT_FOUND' };
    }
    if (error instanceof ContentionError) {
      return { kind: 'retry', errorClass: 'contention' };
    }
    if (error instanceof OutageError) {
      return { kind: 'retry', errorClass: 'outage' };
    }
    // The name only: a driver message can quote the payload's values.
    this.logger.error('unexpected error processing a message', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return { kind: 'retry', errorClass: 'unexpected' };
  }
}
