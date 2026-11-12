import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeRequestContext } from '../../../test/support/fakes/fake-request-context.js';
import { RecordingLogger } from '../../../test/support/fakes/recording-logger.js';
import { RecordingTelemetry } from '../../../test/support/fakes/recording-telemetry.js';
import {
  ContentionError,
  ExternalTransactionIdConflict,
  IdempotencyKeyConflict,
  MessageIdConflict,
  OutageError,
  WalletNotFound,
} from '../errors.js';
import type {
  SubmitCommand,
  SubmitResult,
} from '../wagering/submit-wager-transaction.js';
import {
  type PermanentReason,
  ProcessWagerMessage,
  WAGER_CONSUMER_NAME,
  type WagerMessage,
} from './process-wager-message.js';

const MESSAGE: WagerMessage = {
  messageId: 'msg-1',
  sqsMessageId: 'sqs-1',
  idempotencyKey: 'provider-a:tx-1',
  operation: {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: 'bbbbbbbb-0000-7000-8000-000000000000',
    walletId: 'aaaaaaaa-0000-7000-8000-000000000000',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  },
};

function result(replay: boolean, duplicate: boolean): SubmitResult {
  return {
    transaction: { status: 'PROCESSED' } as SubmitResult['transaction'],
    replay,
    duplicate,
  };
}

/** Answers every submission with `answer`, and records the commands. */
class FakeSubmitter {
  readonly commands: SubmitCommand[] = [];
  answer: () => Promise<SubmitResult> = () =>
    Promise.resolve(result(false, false));

  execute(command: SubmitCommand): Promise<SubmitResult> {
    this.commands.push(command);
    return this.answer();
  }
}

describe('ProcessWagerMessage', () => {
  let submitter: FakeSubmitter;
  let telemetry: RecordingTelemetry;
  let logger: RecordingLogger;
  let context: FakeRequestContext;
  let process: ProcessWagerMessage;

  beforeEach(() => {
    submitter = new FakeSubmitter();
    telemetry = new RecordingTelemetry();
    logger = new RecordingLogger();
    context = new FakeRequestContext();
    process = new ProcessWagerMessage(submitter, telemetry, logger, context);
  });

  const failWith = (error: unknown) => {
    submitter.answer = () => Promise.reject(error);
  };

  it('submits over the sqs channel with the inbox delivery and the messageId as correlation and causation', async () => {
    await process.execute(MESSAGE);
    expect(submitter.commands).toEqual([
      {
        operation: MESSAGE.operation,
        idempotencyKey: MESSAGE.idempotencyKey,
        channel: 'sqs',
        correlationId: 'msg-1',
        causationId: 'msg-1',
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: 'msg-1' },
      },
    ]);
  });

  it('acks a new decision as processed', async () => {
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'ack',
      reason: 'processed',
    });
    expect(telemetry.calls).toEqual([]);
  });

  it('acks a replay of another channel as a replay', async () => {
    submitter.answer = () => Promise.resolve(result(true, false));
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'ack',
      reason: 'replay',
    });
    expect(telemetry.of('inboxDuplicate')).toEqual([]);
  });

  it('acks a repeated delivery as a duplicate and counts it', async () => {
    submitter.answer = () => Promise.resolve(result(true, true));
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'ack',
      reason: 'duplicate',
    });
    expect(telemetry.of('inboxDuplicate')).toEqual([[]]);
  });

  it('moves a reused messageId to the DLQ and counts it', async () => {
    failWith(new MessageIdConflict('msg-1'));
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'dlq',
      reason: 'MESSAGE_ID_CONFLICT',
    });
    expect(telemetry.of('messageIdConflict')).toEqual([[]]);
    expect(logger.warnings).toHaveLength(1);
  });

  it('moves identity conflicts and an unknown wallet to the DLQ at once', async () => {
    const cases: [Error, PermanentReason][] = [
      [new IdempotencyKeyConflict(), 'IDEMPOTENCY_KEY_CONFLICT'],
      [new ExternalTransactionIdConflict(), 'EXTERNAL_TRANSACTION_ID_CONFLICT'],
      [new WalletNotFound(MESSAGE.operation.walletId), 'WALLET_NOT_FOUND'],
    ];
    for (const [error, reason] of cases) {
      failWith(error);
      expect(await process.execute(MESSAGE)).toEqual({ kind: 'dlq', reason });
    }
  });

  it('retries contention and outages under their class', async () => {
    failWith(new ContentionError('lock timeout'));
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'retry',
      errorClass: 'contention',
    });
    failWith(new OutageError('postgres', 'connection refused'));
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'retry',
      errorClass: 'outage',
    });
    expect(logger.errors).toEqual([]);
  });

  it('retries anything else as unexpected and logs only the error name', async () => {
    failWith(new TypeError('amount 10.00 is bad'));
    expect(await process.execute(MESSAGE)).toEqual({
      kind: 'retry',
      errorClass: 'unexpected',
    });
    expect(logger.errors).toEqual([
      {
        message: 'unexpected error processing a message',
        fields: { reason: 'TypeError' },
      },
    ]);
  });
});
