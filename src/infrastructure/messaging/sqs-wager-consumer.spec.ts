import { afterEach, describe, expect, it } from 'bun:test';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import type { CircuitState } from '@nestjs/resilience';
import { FakeRequestContext } from '../../../test/support/fakes/fake-request-context.js';
import { RecordingLogger } from '../../../test/support/fakes/recording-logger.js';
import { waitFor } from '../../../test/support/wait-for.js';
import type {
  MessageOutcome,
  WagerMessage,
} from '../../application/messaging/process-wager-message.js';
import type { DlqMove } from './sqs-dlq-mover.js';
import { SqsWagerConsumer } from './sqs-wager-consumer.js';

const WALLET = 'aaaaaaaa-0000-7000-8000-000000000000';

function body(messageId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: `tx-${messageId}`,
      idempotencyKey: `key-${messageId}`,
      playerId: 'bbbbbbbb-0000-7000-8000-000000000000',
      walletId: WALLET,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      ...overrides,
    },
  });
}

function message(id: string, group: string, receiveCount = 1): Message {
  return {
    MessageId: `sqs-${id}`,
    ReceiptHandle: `rh-${id}`,
    Body: body(id),
    Attributes: {
      MessageGroupId: group,
      ApproximateReceiveCount: String(receiveCount),
    },
  };
}

/** Waits up to 1 s for `condition`, with polling fast enough for in-memory fakes. */
const until = (condition: () => boolean) =>
  waitFor(condition, {
    timeoutMs: 1000,
    intervalMs: 5,
    description: 'the consumer',
  });

type Call = { readonly name: string; readonly input: Record<string, unknown> };

/** Answers receives from a script, then long-polls until aborted; records every call. */
class FakeSqs {
  readonly calls: Call[] = [];
  readonly batches: Message[][] = [];

  send(
    command: { constructor: { name: string }; input: Record<string, unknown> },
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown> {
    const name = command.constructor.name.replace('Command', '');
    this.calls.push({ name, input: command.input });
    if (name === 'GetQueueUrl') return Promise.resolve({ QueueUrl: 'q' });
    if (name !== 'ReceiveMessage') return Promise.resolve({});
    const batch = this.batches.shift();
    if (batch !== undefined) return Promise.resolve({ Messages: batch });
    return new Promise((_, reject) => {
      const signal = options?.abortSignal;
      signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    });
  }

  /** Calls other than receives and URL lookups, as `name:handle[:seconds]`. */
  actions(): string[] {
    return this.calls
      .filter((c) => c.name !== 'ReceiveMessage' && c.name !== 'GetQueueUrl')
      .map((c) => {
        const handle = c.input.ReceiptHandle as string;
        return c.name === 'ChangeMessageVisibility'
          ? `visibility:${handle}:${String(c.input.VisibilityTimeout)}`
          : `${c.name}:${handle}`;
      });
  }
}

type Script = (message: WagerMessage) => Promise<MessageOutcome>;

const ACK: MessageOutcome = { kind: 'ack', reason: 'processed' };

function setup(
  script: Script = () => Promise.resolve(ACK),
  circuits: readonly { readonly state: CircuitState }[] = [],
) {
  const sqs = new FakeSqs();
  const processed: string[] = [];
  const moves: DlqMove[] = [];
  const retries: string[] = [];
  const crashes: string[] = [];
  const logger = new RecordingLogger();
  const consumer = new SqsWagerConsumer({
    sqs: sqs as unknown as SQSClient,
    guard: (call) => call(),
    queues: { url: () => Promise.resolve('q') },
    process: {
      execute: (m) => {
        processed.push(m.messageId);
        return script(m);
      },
    },
    dlq: {
      move: (move: DlqMove) => {
        moves.push(move);
        return Promise.resolve();
      },
    } as never,
    metrics: { sqsRetry: (errorClass) => retries.push(errorClass) },
    logger,
    context: new FakeRequestContext(),
    faults: { crashAfterCommit: () => crashes.push('crash') },
    circuits,
    settings: {
      maxGroups: 4,
      waitTimeSeconds: 20,
      drainMs: 2000,
      idlePollMs: 5,
      visibilityTimeoutSeconds: 30,
      backoff: { baseMs: 2000, capMs: 60_000 },
    },
  });
  return { sqs, consumer, processed, moves, retries, crashes, logger };
}

let running: SqsWagerConsumer | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function start(consumer: SqsWagerConsumer) {
  running = consumer;
  consumer.start();
}

describe('SqsWagerConsumer', () => {
  it('asks for at most the free group slots, with the receive count and group', async () => {
    const { sqs, consumer } = setup();
    start(consumer);
    await until(() => sqs.calls.some((c) => c.name === 'ReceiveMessage'));
    const receive = sqs.calls.find((c) => c.name === 'ReceiveMessage');
    expect(receive?.input).toMatchObject({
      MaxNumberOfMessages: 4,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: [
        'ApproximateReceiveCount',
        'MessageGroupId',
      ],
    });
  });

  it('runs a group in order, extending each waiting message, and deletes after each ack', async () => {
    const { sqs, consumer, processed, crashes } = setup();
    sqs.batches.push([
      message('a1', 'A'),
      message('a2', 'A'),
      message('a3', 'A'),
    ]);
    start(consumer);
    await until(() => processed.length === 3);
    await until(() => sqs.actions().length === 5);
    expect(processed).toEqual(['a1', 'a2', 'a3']);
    expect(sqs.actions()).toEqual([
      'DeleteMessage:rh-a1',
      'visibility:rh-a2:30',
      'DeleteMessage:rh-a2',
      'visibility:rh-a3:30',
      'DeleteMessage:rh-a3',
    ]);
    expect(crashes).toHaveLength(3);
  });

  it('runs different groups in parallel', async () => {
    const gates: { resolve: (outcome: MessageOutcome) => void }[] = [];
    const { sqs, consumer, processed } = setup(() => {
      const gate = Promise.withResolvers<MessageOutcome>();
      gates.push(gate);
      return gate.promise;
    });
    sqs.batches.push([message('a1', 'A'), message('b1', 'B')]);
    start(consumer);
    await until(() => processed.length === 2);
    expect(processed.sort()).toEqual(['a1', 'b1']);
    for (const gate of gates) gate.resolve(ACK);
  });

  it('backs a failed message off and releases the rest of its group at once', async () => {
    const { sqs, consumer, processed, retries } = setup((m) =>
      Promise.resolve(
        m.messageId === 'a1'
          ? { kind: 'retry', errorClass: 'contention' }
          : ACK,
      ),
    );
    sqs.batches.push([
      message('a1', 'A', 2),
      message('a2', 'A'),
      message('a3', 'A'),
    ]);
    start(consumer);
    await until(() => sqs.actions().length === 3);
    expect(processed).toEqual(['a1']);
    expect(retries).toEqual(['contention']);
    expect(sqs.actions()).toEqual([
      'visibility:rh-a1:4',
      'visibility:rh-a2:0',
      'visibility:rh-a3:0',
    ]);
  });

  it('moves a spent budget to the DLQ and goes on with the group', async () => {
    const { sqs, consumer, processed, moves } = setup((m) =>
      Promise.resolve(
        m.messageId === 'a1'
          ? { kind: 'retry', errorClass: 'unexpected' }
          : ACK,
      ),
    );
    sqs.batches.push([message('a1', 'A', 3), message('a2', 'A')]);
    start(consumer);
    await until(() => processed.length === 2);
    expect(moves).toMatchObject([
      {
        reason: 'UNEXPECTED_ERROR',
        errorClass: 'unexpected',
        receiveCount: 3,
        deduplicationId: 'a1',
        groupId: 'A',
      },
    ]);
  });

  it('moves a permanent outcome to the DLQ with the envelope messageId', async () => {
    const { sqs, consumer, moves } = setup(() =>
      Promise.resolve({ kind: 'dlq', reason: 'WALLET_NOT_FOUND' }),
    );
    sqs.batches.push([message('a1', 'A')]);
    start(consumer);
    await until(() => moves.length === 1);
    expect(moves[0]).toMatchObject({
      reason: 'WALLET_NOT_FOUND',
      errorClass: 'permanent',
      deduplicationId: 'a1',
    });
  });

  it('moves an invalid envelope to the DLQ with the SQS MessageId, without processing it', async () => {
    const { sqs, consumer, processed, moves } = setup();
    const invalid = { ...message('a1', 'A'), Body: '{"messageId":"a1"}' };
    const notJson = { ...message('a2', 'A'), Body: 'not json' };
    sqs.batches.push([invalid, notJson]);
    start(consumer);
    await until(() => moves.length === 2);
    expect(processed).toEqual([]);
    expect(moves.map((m) => [m.reason, m.deduplicationId])).toEqual([
      ['VALIDATION_FAILED', 'sqs-a1'],
      ['VALIDATION_FAILED', 'sqs-a2'],
    ]);
  });

  it('passes the operation without the key, and the key on its own', async () => {
    const seen: WagerMessage[] = [];
    const { sqs, consumer } = setup((m) => {
      seen.push(m);
      return Promise.resolve(ACK);
    });
    sqs.batches.push([message('a1', 'A')]);
    start(consumer);
    await until(() => seen.length === 1);
    expect(seen[0]?.idempotencyKey).toBe('key-a1');
    expect(seen[0]?.sqsMessageId).toBe('sqs-a1');
    expect(seen[0]?.operation).not.toHaveProperty('idempotencyKey');
    expect(seen[0]?.operation.walletId).toBe(WALLET);
  });

  it('on stop finishes the message in progress and releases the rest of its group', async () => {
    const gate = Promise.withResolvers<MessageOutcome>();
    const { sqs, consumer, processed } = setup(() => gate.promise);
    sqs.batches.push([message('a1', 'A'), message('a2', 'A')]);
    consumer.start();
    await until(() => processed.length === 1);
    const stopped = consumer.stop();
    gate.resolve(ACK);
    await stopped;
    expect(processed).toEqual(['a1']);
    expect(sqs.actions()).toEqual([
      'DeleteMessage:rh-a1',
      'visibility:rh-a2:0',
    ]);
  });

  it('receives nothing while a needed circuit is open', async () => {
    const circuit: { state: 'open' | 'closed' } = { state: 'open' };
    const { sqs, consumer } = setup(undefined, [circuit]);
    start(consumer);
    // Several idle polls pass with the circuit open.
    await Bun.sleep(50);
    expect(sqs.calls).toEqual([]);
    circuit.state = 'closed';
    await until(() => sqs.calls.some((c) => c.name === 'ReceiveMessage'));
  });

  it('short-polls while a circuit is half-open, so the probe settles at once', async () => {
    const { sqs, consumer } = setup(undefined, [{ state: 'half-open' }]);
    start(consumer);
    await until(() => sqs.calls.some((c) => c.name === 'ReceiveMessage'));
    const receive = sqs.calls.find((c) => c.name === 'ReceiveMessage');
    expect(receive?.input.WaitTimeSeconds).toBe(0);
  });
});
