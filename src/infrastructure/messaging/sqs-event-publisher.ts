import {
  type BatchResultErrorEntry,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  EventPublisher,
  PublishEntry,
  PublishResult,
} from '../../application/ports/event-publisher.js';
import type { FaultInjection } from '../fault-injection.js';
import type { CallGuard } from '../persistence/mikro-orm-unit-of-work.js';
import type { SqsQueues } from './sqs-queues.js';

/** The send abort from the tuning table. */
export const OUTBOX_SEND_TIMEOUT_MS = 5000;

/** `last_error` is free text; a broker message is cut to this length. */
const MAX_ERROR_LENGTH = 500;

export type SqsEventPublisherOptions = {
  /** A client with `maxAttempts: 1`: the outbox retries, not the SDK. */
  readonly sqs: SQSClient;
  /** The `sqs` circuit. */
  readonly guard: CallGuard;
  readonly queues: Pick<SqsQueues, 'url'>;
  readonly faults: Pick<FaultInjection, 'crashAfterSend'>;
  readonly sendTimeoutMs?: number;
};

function reasonOf(failure: BatchResultErrorEntry): string {
  const code = failure.Code ?? 'UnknownError';
  const reason =
    failure.Message === undefined ? code : `${code}: ${failure.Message}`;
  return reason.slice(0, MAX_ERROR_LENGTH);
}

/**
 * The `EventPublisher` adapter (§13): one `SendMessageBatch` to
 * `wagering-events.fifo`, with `MessageGroupId` the wallet and
 * `MessageDeduplicationId` the `eventId`, so a republish within five
 * minutes is dropped by SQS. One attempt, aborted after 5 s, through the
 * `sqs` circuit: an unreachable SQS throws, and the cycle counts nothing.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly options: SqsEventPublisherOptions) {}

  async publishBatch(
    entries: readonly PublishEntry[],
  ): Promise<PublishResult[]> {
    if (entries.length === 0) return [];
    const { sqs, guard, queues, faults } = this.options;
    const queueUrl = await queues.url('events');
    const timeoutMs = this.options.sendTimeoutMs ?? OUTBOX_SEND_TIMEOUT_MS;
    // Batch entry IDs are positions: an eventId is not guaranteed to fit SQS's rules.
    const output = await guard(() =>
      sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: entries.map((entry, index) => ({
            Id: String(index),
            MessageBody: entry.body,
            MessageGroupId: entry.groupId,
            MessageDeduplicationId: entry.id,
          })),
        }),
        { abortSignal: AbortSignal.timeout(timeoutMs) },
      ),
    );
    faults.crashAfterSend();

    const sent = new Set((output.Successful ?? []).map((s) => s.Id));
    const failed = new Map((output.Failed ?? []).map((f) => [f.Id, f]));
    return entries.map((entry, index): PublishResult => {
      const id = String(index);
      if (sent.has(id)) return { id: entry.id, ok: true, senderFault: false };
      const failure = failed.get(id);
      return failure === undefined
        ? {
            id: entry.id,
            ok: false,
            senderFault: false,
            error: 'missing from the batch result',
          }
        : {
            id: entry.id,
            ok: false,
            senderFault: failure.SenderFault === true,
            error: reasonOf(failure),
          };
    });
  }
}
