import {
  DeleteMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, mock } from 'bun:test';
import { SqsDlqMover } from './sqs-dlq-mover.js';

function mover() {
  const sent: unknown[] = [];
  const sqs = {
    send: mock(async (command: unknown) => {
      sent.push(command);
      return {};
    }),
  } as unknown as SQSClient;
  const onMoved = mock(() => {});
  const subject = new SqsDlqMover({
    sqs,
    guard: (call) => call(),
    queues: { url: async (name) => `https://sqs.test/${name}` },
    instanceId: 'i-1',
    onMoved,
  });
  return { subject, sent, onMoved };
}

const move = (MessageId?: string) => ({
  message: { MessageId, Body: 'body', ReceiptHandle: 'r-1' },
  reason: 'VALIDATION_FAILED' as const,
  errorClass: 'permanent' as const,
  receiveCount: 1,
  groupId: 'A',
});

describe('SqsDlqMover', () => {
  it('deduplicates the DLQ copy by the source MessageId', async () => {
    const { subject, sent, onMoved } = mover();

    await subject.move(move('sqs-a1'));

    const [send, remove] = sent;
    expect(send).toBeInstanceOf(SendMessageCommand);
    expect((send as SendMessageCommand).input.MessageDeduplicationId).toBe(
      'sqs-a1',
    );
    expect(remove).toBeInstanceOf(DeleteMessageCommand);
    expect(onMoved).toHaveBeenCalledWith('VALIDATION_FAILED');
  });

  it('still moves a delivery that has no MessageId', async () => {
    const { subject, sent } = mover();

    await subject.move(move());

    const send = sent[0] as SendMessageCommand;
    expect(send.input.MessageDeduplicationId).toBeString();
    expect(send.input.MessageDeduplicationId).not.toBe('');
    expect(sent[1]).toBeInstanceOf(DeleteMessageCommand);
  });
});
