import { describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { UNGUARDED } from '../persistence/mikro-orm-unit-of-work.js';
import { SqsEventPublisher } from './sqs-event-publisher.js';

type Sent = {
  readonly input: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
};

/** Answers every `SendMessageBatch` with `answer`; records the calls and the order of events. */
class FakeSqs {
  readonly sent: Sent[] = [];

  constructor(
    private readonly answer: () => Promise<unknown>,
    private readonly log: string[],
  ) {}

  send(
    command: { input: Record<string, unknown> },
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown> {
    this.sent.push({ input: command.input, signal: options?.abortSignal });
    this.log.push('send');
    return this.answer();
  }
}

const entries = [
  { id: 'event-1', groupId: 'wallet-1', body: '{"eventId":"event-1"}' },
  { id: 'event-2', groupId: 'wallet-1', body: '{"eventId":"event-2"}' },
  { id: 'event-3', groupId: 'wallet-2', body: '{"eventId":"event-3"}' },
];

function publisherWith(answer: () => Promise<unknown>) {
  const log: string[] = [];
  const sqs = new FakeSqs(answer, log);
  const publisher = new SqsEventPublisher({
    sqs: sqs as unknown as SQSClient,
    guard: UNGUARDED,
    queues: { url: () => Promise.resolve('events-url') },
    faults: { crashAfterSend: () => log.push('crash-after-send') },
  });
  return { publisher, sqs, log };
}

describe('SqsEventPublisher', () => {
  it('sends one batch with the wallet as group and the eventId as deduplication ID', async () => {
    const { publisher, sqs, log } = publisherWith(() =>
      Promise.resolve({
        Successful: [{ Id: '0' }, { Id: '1' }, { Id: '2' }],
      }),
    );

    const results = await publisher.publishBatch(entries);

    expect(results).toEqual(
      entries.map((entry) => ({ id: entry.id, ok: true, senderFault: false })),
    );
    expect(sqs.sent).toHaveLength(1);
    expect(sqs.sent[0]?.input).toEqual({
      QueueUrl: 'events-url',
      Entries: entries.map((entry, index) => ({
        Id: String(index),
        MessageBody: entry.body,
        MessageGroupId: entry.groupId,
        MessageDeduplicationId: entry.id,
      })),
    });
    expect(sqs.sent[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(log).toEqual(['send', 'crash-after-send']);
  });

  it('maps failed and unanswered entries to their eventIds', async () => {
    const { publisher } = publisherWith(() =>
      Promise.resolve({
        Successful: [{ Id: '0' }],
        Failed: [
          {
            Id: '1',
            Code: 'InvalidMessageContents',
            Message: 'bad body',
            SenderFault: true,
          },
        ],
      }),
    );

    expect(await publisher.publishBatch(entries)).toEqual([
      { id: 'event-1', ok: true, senderFault: false },
      {
        id: 'event-2',
        ok: false,
        senderFault: true,
        error: 'InvalidMessageContents: bad body',
      },
      {
        id: 'event-3',
        ok: false,
        senderFault: false,
        error: 'missing from the batch result',
      },
    ]);
  });

  it('throws when the call fails, before the fault point', async () => {
    const unreachable = new Error('connect ECONNREFUSED');
    const { publisher, log } = publisherWith(() => Promise.reject(unreachable));

    expect(await rejectionOf(publisher.publishBatch(entries))).toBe(
      unreachable,
    );
    expect(log).toEqual(['send']);
  });

  it('calls nothing for an empty batch', async () => {
    const { publisher, log } = publisherWith(() => Promise.resolve({}));
    expect(await publisher.publishBatch([])).toEqual([]);
    expect(log).toEqual([]);
  });
});
