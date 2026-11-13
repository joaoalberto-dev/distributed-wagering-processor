import {
  DeleteMessageCommand,
  type Message,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  DlqReason,
  RetryClass,
} from '../../application/messaging/process-wager-message.js';
import type { CallGuard } from '../persistence/mikro-orm-unit-of-work.js';
import type { SqsQueues } from './sqs-queues.js';

/** The `errorClass` attribute: the retry class, or `permanent` for a reason moved at once. */
export type DlqErrorClass = RetryClass | 'permanent';

export type DlqMove = {
  readonly message: Message;
  readonly reason: DlqReason;
  readonly errorClass: DlqErrorClass;
  readonly receiveCount: number;
  /** The original `MessageGroupId`. */
  readonly groupId: string;
};

export type DlqMoverOptions = {
  readonly sqs: SQSClient;
  /** The `sqs` circuit. */
  readonly guard: CallGuard;
  readonly queues: Pick<SqsQueues, 'url'>;
  readonly instanceId: string;
  readonly onMoved: (reason: DlqReason) => void;
};

const attribute = (value: string) => ({
  DataType: 'String',
  StringValue: value,
});

/**
 * The one application DLQ path (§12): send the body unchanged to the DLQ,
 * in the original group, with the reason attributes; then delete it from
 * the input queue. If the delete fails, the message is received again and
 * moved again; the DLQ's deduplication ID drops the second copy within the
 * five-minute window.
 */
export class SqsDlqMover {
  constructor(private readonly options: DlqMoverOptions) {}

  async move(move: DlqMove): Promise<void> {
    const { sqs, guard, queues, instanceId } = this.options;
    // SQS always sets a MessageId. Without one, a random ID still moves the
    // message; a repeat move after a failed delete is then not deduplicated.
    const sourceMessageId = move.message.MessageId ?? crypto.randomUUID();
    const deadLetterQueueUrl = await queues.url('deadLetter');
    await guard(() =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          MessageBody: move.message.Body ?? '',
          MessageGroupId: move.groupId,
          MessageDeduplicationId: sourceMessageId,
          MessageAttributes: {
            failureReason: attribute(move.reason),
            receiveCount: attribute(String(move.receiveCount)),
            instanceId: attribute(instanceId),
            errorClass: attribute(move.errorClass),
          },
        }),
      ),
    );
    this.options.onMoved(move.reason);
    const inputQueueUrl = await queues.url('input');
    await guard(() =>
      sqs.send(
        new DeleteMessageCommand({
          QueueUrl: inputQueueUrl,
          ReceiptHandle: move.message.ReceiptHandle,
        }),
      ),
    );
  }
}
