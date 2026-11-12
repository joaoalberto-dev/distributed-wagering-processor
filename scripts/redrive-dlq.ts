/**
 * Moves redrivable messages from the DLQ back to the input queue
 * (ARCHITECTURE.md §5, redrive procedure, steps 2 to 4).
 *
 *   bun scripts/redrive-dlq.ts [--include-unexpected] [--dry-run]
 *
 * Only `RETRY_BUDGET_EXHAUSTED` is redriven by default; `--include-unexpected`
 * adds `UNEXPECTED_ERROR`, for use after its cause is fixed. Permanent
 * reasons, and messages SQS moved itself (no `failureReason`), are never
 * redriven: they stay in the DLQ and are listed.
 *
 * Each message is sent unchanged, in its original group, then deleted from
 * the DLQ. The deduplication ID derives from the DLQ message's own SQS
 * `MessageId`: a rerun after a stop between send and delete is dropped by
 * the input queue's deduplication window, and a later DLQ copy of the same
 * operation has a new `MessageId`, so it is never dropped. The envelope
 * `messageId` in the body is unchanged, so the inbox gives every copy one
 * effect.
 */
import { parseArgs } from 'node:util';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { DlqReason } from '../src/application/messaging/process-wager-message.js';
import {
  loadConfig,
  queueNames,
} from '../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client.js';

/** The reasons whose message may succeed when sent again unchanged. */
export type RedrivableReason = Extract<
  DlqReason,
  'RETRY_BUDGET_EXHAUSTED' | 'UNEXPECTED_ERROR'
>;

export type RedriveOptions = {
  readonly sqs: SQSClient;
  readonly deadLetterQueueUrl: string;
  readonly inputQueueUrl: string;
  readonly reasons: ReadonlySet<RedrivableReason>;
  /** List what would move, and move nothing. */
  readonly dryRun?: boolean;
  /** How long a received DLQ message stays hidden while the run lasts. */
  readonly visibilityTimeoutSeconds?: number;
};

export type RedriveItem = {
  /** The DLQ message's SQS `MessageId`. */
  readonly dlqMessageId: string;
  readonly groupId: string | undefined;
  /** `undefined` for a message SQS moved itself, after 50 receives. */
  readonly failureReason: string | undefined;
};

export type RedriveReport = {
  readonly redriven: readonly RedriveItem[];
  readonly skipped: readonly RedriveItem[];
};

const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;

/**
 * Reads the DLQ until a receive comes back empty. Every message received is
 * hidden for the rest of the run, so none is read twice; the ones left in
 * the DLQ are made visible again at the end.
 *
 * A FIFO queue hides the rest of a group while one of its messages is in
 * flight, so the messages behind a skipped one in the same group are not
 * seen in this run. They stay in the DLQ, in order.
 */
export async function redriveDlq(
  options: RedriveOptions,
): Promise<RedriveReport> {
  const { sqs, deadLetterQueueUrl, inputQueueUrl } = options;
  const redriven: RedriveItem[] = [];
  const skipped: RedriveItem[] = [];
  const leftInDlq: string[] = [];
  try {
    for (;;) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: deadLetterQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout:
            options.visibilityTimeoutSeconds ??
            DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['MessageGroupId'],
        }),
      );
      if (Messages.length === 0) break;
      for (const message of Messages) {
        const item = itemOf(message);
        const redrivable =
          item.failureReason !== undefined &&
          options.reasons.has(item.failureReason as RedrivableReason);
        if (!redrivable || options.dryRun === true) {
          (redrivable ? redriven : skipped).push(item);
          leftInDlq.push(receiptOf(message));
          continue;
        }
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: inputQueueUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: item.groupId,
            MessageDeduplicationId: `${item.dlqMessageId}-redrive`,
          }),
        );
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: deadLetterQueueUrl,
            ReceiptHandle: receiptOf(message),
          }),
        );
        redriven.push(item);
      }
    }
  } finally {
    for (const receiptHandle of leftInDlq) {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: deadLetterQueueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    }
  }
  return { redriven, skipped };
}

function itemOf(message: Message): RedriveItem {
  if (message.MessageId === undefined) {
    throw new Error('SQS returned a message without a MessageId');
  }
  return {
    dlqMessageId: message.MessageId,
    groupId: message.Attributes?.MessageGroupId,
    failureReason: message.MessageAttributes?.failureReason?.StringValue,
  };
}

function receiptOf(message: Message): string {
  if (message.ReceiptHandle === undefined) {
    throw new Error(`SQS message ${message.MessageId} has no receipt handle`);
  }
  return message.ReceiptHandle;
}

async function queueUrl(sqs: SQSClient, name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: name }),
  );
  if (QueueUrl === undefined) throw new Error(`Queue ${name} not found`);
  return QueueUrl;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'include-unexpected': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const config = loadConfig(process.env);
  const names = queueNames(config);
  const sqs = createSqsClient(config);
  try {
    const reasons = new Set<RedrivableReason>(['RETRY_BUDGET_EXHAUSTED']);
    if (values['include-unexpected']) reasons.add('UNEXPECTED_ERROR');
    const report = await redriveDlq({
      sqs,
      deadLetterQueueUrl: await queueUrl(sqs, names.deadLetter),
      inputQueueUrl: await queueUrl(sqs, names.input),
      reasons,
      dryRun: values['dry-run'],
    });
    const verb = values['dry-run'] ? 'would redrive' : 'redriven';
    for (const item of report.redriven) {
      console.log(
        `${verb}: ${item.dlqMessageId} group=${item.groupId} reason=${item.failureReason}`,
      );
    }
    for (const item of report.skipped) {
      console.log(
        `left in DLQ: ${item.dlqMessageId} group=${item.groupId} reason=${item.failureReason ?? 'none (native redrive)'}`,
      );
    }
    console.log(
      `redrive-dlq: ${report.redriven.length} ${verb}, ${report.skipped.length} left in ${names.deadLetter}`,
    );
  } finally {
    sqs.destroy();
  }
}
