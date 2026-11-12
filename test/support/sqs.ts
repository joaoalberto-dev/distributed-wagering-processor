import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { WagerBody } from './factories.js';
import type { Infrastructure } from './infrastructure.js';
import { waitFor } from './wait-for.js';

/** The body of a message on the input queue (§8, SQS message shape). */
export type Envelope = {
  readonly messageId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: WagerBody & { readonly idempotencyKey: string };
};

/** An envelope for `body` under its recommended key and a fresh `messageId`. */
export function envelopeOf(
  body: WagerBody,
  overrides: { messageId?: string; idempotencyKey?: string } = {},
): Envelope {
  return {
    messageId: overrides.messageId ?? `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      ...body,
      idempotencyKey:
        overrides.idempotencyKey ??
        `${body.providerId}:${body.externalTransactionId}`,
    },
  };
}

export type SendOptions = {
  /** The FIFO group; the operation's wallet by default (§12). */
  readonly groupId?: string;
  /** A fresh one by default, so a repeated envelope is a second delivery, not a dropped copy. */
  readonly deduplicationId?: string;
};

export type QueueCounts = {
  /** `ApproximateNumberOfMessages`. */
  readonly visible: number;
  /** `ApproximateNumberOfMessagesNotVisible`. */
  readonly inFlight: number;
};

export type DlqMessage = {
  readonly body: string;
  readonly groupId: string | undefined;
  readonly failureReason: string | undefined;
  readonly receiveCount: number;
  readonly instanceId: string | undefined;
  readonly errorClass: string | undefined;
  /** The envelope `messageId`, when the body is an envelope. */
  readonly messageId: string | undefined;
};

/**
 * The spec's own queues, seen from the test: send envelopes, read counts,
 * and collect DLQ messages. DLQ messages are deleted as they are collected,
 * so a FIFO group in the DLQ never hides the next one.
 */
export class TestQueues {
  readonly #dlq: DlqMessage[] = [];

  constructor(private readonly infrastructure: Infrastructure) {}

  /** Sends an envelope, or a raw body, and returns the SQS `MessageId`. */
  async send(
    message: Envelope | string,
    options: SendOptions = {},
  ): Promise<string> {
    const body =
      typeof message === 'string' ? message : JSON.stringify(message);
    const groupId =
      options.groupId ??
      (typeof message === 'string' ? 'raw' : message.data.walletId);
    const { MessageId } = await this.infrastructure.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.infrastructure.queueUrls.input,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: options.deduplicationId ?? Bun.randomUUIDv7(),
      }),
    );
    if (MessageId === undefined) throw new Error('SQS returned no MessageId');
    return MessageId;
  }

  async counts(queue: 'input' | 'deadLetter' = 'input'): Promise<QueueCounts> {
    const { Attributes } = await this.infrastructure.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.infrastructure.queueUrls[queue],
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );
    return {
      visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  }

  /** Waits until the input queue has no visible and no in-flight message. */
  async drained(timeoutMs = 30_000): Promise<void> {
    await waitFor(
      async () => {
        const counts = await this.counts('input');
        return counts.visible === 0 && counts.inFlight === 0;
      },
      { timeoutMs, intervalMs: 200, description: 'the input queue to drain' },
    );
  }

  /** Every DLQ message collected so far, after one more short receive. */
  async deadLetters(): Promise<readonly DlqMessage[]> {
    const { Messages } = await this.infrastructure.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.infrastructure.queueUrls.deadLetter,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    for (const message of Messages ?? []) {
      const attribute = (name: string) =>
        message.MessageAttributes?.[name]?.StringValue;
      this.#dlq.push({
        body: message.Body ?? '',
        groupId: message.Attributes?.MessageGroupId,
        failureReason: attribute('failureReason'),
        receiveCount: Number(attribute('receiveCount') ?? 0),
        instanceId: attribute('instanceId'),
        errorClass: attribute('errorClass'),
        messageId: envelopeMessageId(message.Body),
      });
      await this.infrastructure.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.infrastructure.queueUrls.deadLetter,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
    return [...this.#dlq];
  }

  /** Waits for the DLQ message whose envelope `messageId` (or body) matches. */
  deadLetter(
    match: (message: DlqMessage) => boolean,
    timeoutMs = 30_000,
  ): Promise<DlqMessage> {
    return waitFor(async () => (await this.deadLetters()).find(match), {
      timeoutMs,
      intervalMs: 0,
      description: 'a DLQ message',
    });
  }
}

function envelopeMessageId(body: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(body ?? '') as { messageId?: unknown };
    return typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
  } catch {
    return undefined;
  }
}
