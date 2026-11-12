import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { CircuitState } from '@nestjs/resilience';
import type {
  MessageOutcome,
  WagerMessage,
} from '../../application/messaging/process-wager-message.js';
import type { AppLogger } from '../../application/ports/logger.js';
import type { RequestContext } from '../../application/ports/request-context.js';
import { sqsEnvelope } from '../../contracts/sqs-envelope.schema.js';
import type { FaultInjection } from '../fault-injection.js';
import type { Metrics } from '../observability/metrics.js';
import type { CallGuard } from '../persistence/mikro-orm-unit-of-work.js';
import { realSleep, type Sleep } from '../polling/polling-loop.js';
import type { SqsDlqMover } from './sqs-dlq-mover.js';
import type { SqsQueues } from './sqs-queues.js';
import { decideRetry, type SqsBackoff } from './sqs-retry-policy.js';

/** The consumer's values from the tuning table. */
export const SQS_CONSUMER_DEFAULTS = {
  maxGroups: 4,
  waitTimeSeconds: 20,
  drainMs: 20_000,
  idlePollMs: 1000,
} as const;

export type SqsConsumerSettings = {
  /** Message groups in progress at once: the consumer's connection share. */
  readonly maxGroups: number;
  /** The long poll. */
  readonly waitTimeSeconds: number;
  /** How long a stop waits for the messages in progress. */
  readonly drainMs: number;
  /** The wait after a failed receive, or while a circuit is open. */
  readonly idlePollMs: number;
  /** Restored before each waiting message of a group starts. */
  readonly visibilityTimeoutSeconds: number;
  readonly backoff: SqsBackoff;
};

export type SqsConsumerOptions = {
  readonly sqs: SQSClient;
  /** The `sqs` circuit around every SQS call. */
  readonly guard: CallGuard;
  readonly queues: Pick<SqsQueues, 'url'>;
  readonly process: { execute(message: WagerMessage): Promise<MessageOutcome> };
  readonly dlq: SqsDlqMover;
  readonly metrics: Pick<Metrics, 'sqsRetry'>;
  readonly logger: AppLogger;
  readonly context: RequestContext;
  readonly faults: Pick<FaultInjection, 'crashAfterCommit'>;
  /** The circuits a cycle needs (`postgres`, `sqs`); any open one pauses receiving. */
  readonly circuits: readonly { readonly state: CircuitState }[];
  readonly settings: SqsConsumerSettings;
  readonly sleep?: Sleep;
};

/** How one message ended, for the rest of its group. */
type Handled = 'done' | 'backoff';

/**
 * The SQS inbound adapter (§12).
 *
 * *   A receive asks for at most the free group slots, so the consumer never
 *     holds a message it cannot start.
 * *   Each batch is split by `MessageGroupId`. A group runs its messages one
 *     after another in SQS order; groups run in parallel.
 * *   Before each waiting message of a group starts, its visibility is
 *     restored, so a long group never lets it reach another instance.
 * *   A backoff releases the rest of the group at visibility 0, so SQS
 *     delivers the group again in order. After a DLQ move the group goes on.
 * *   A message is deleted only after its outcome committed.
 * *   While a needed circuit is open, nothing is received, so an outage
 *     spends no receive budget. While one is half-open, the receive is a
 *     short poll, so the probe settles at once.
 * *   `stop` aborts the long poll, lets each group finish the message in
 *     progress within the drain time, and releases the rest.
 */
export class SqsWagerConsumer {
  readonly #options: SqsConsumerOptions;
  readonly #sleep: Sleep;
  readonly #groups = new Set<Promise<void>>();
  #abort: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(options: SqsConsumerOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? realSleep;
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  start(): void {
    if (this.#running !== undefined) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#running = this.#loop(abort.signal);
  }

  async stop(): Promise<void> {
    const running = this.#running;
    if (running === undefined) return;
    this.#abort?.abort();
    await running;
    const drained = Promise.all(this.#groups).then(() => true);
    const timer = Promise.withResolvers<boolean>();
    const handle = setTimeout(
      () => timer.resolve(false),
      this.#options.settings.drainMs,
    );
    const inTime = await Promise.race([drained, timer.promise]);
    clearTimeout(handle);
    if (!inTime) {
      this.#options.logger.warn('sqs consumer drain timed out', {
        groups: this.#groups.size,
      });
    }
    this.#abort = undefined;
    this.#running = undefined;
  }

  async #loop(signal: AbortSignal): Promise<void> {
    const { settings, circuits } = this.#options;
    const stopped = aborted(signal);
    while (!signal.aborted) {
      if (circuits.some((circuit) => circuit.state === 'open')) {
        await this.#sleep(settings.idlePollMs, signal);
        continue;
      }
      const free = settings.maxGroups - this.#groups.size;
      if (free <= 0) {
        await Promise.race([...this.#groups, stopped]);
        continue;
      }
      let messages: Message[];
      try {
        messages = await this.#receive(free, signal);
      } catch (error) {
        if (signal.aborted) break;
        this.#options.logger.warn('sqs receive failed', {
          reason: error instanceof Error ? error.name : 'unknown',
        });
        await this.#sleep(settings.idlePollMs, signal);
        continue;
      }
      for (const group of byGroup(messages)) {
        const running = this.#runGroup(group, signal).finally(() =>
          this.#groups.delete(running),
        );
        this.#groups.add(running);
      }
    }
  }

  async #receive(max: number, signal: AbortSignal): Promise<Message[]> {
    const { sqs, guard, queues, settings, circuits } = this.#options;
    const queueUrl = await queues.url('input');
    // A half-open circuit's probe must settle at once: a long poll on an
    // empty queue would keep the circuit half-open, refusing every other
    // call of the process, for the whole poll.
    const probing = circuits.some((circuit) => circuit.state === 'half-open');
    const output = await guard(() =>
      sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(max, 10),
          WaitTimeSeconds: probing ? 0 : settings.waitTimeSeconds,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
        }),
        { abortSignal: signal },
      ),
    );
    return output.Messages ?? [];
  }

  /** Runs one group's messages in order; a stop or a backoff releases the rest. */
  async #runGroup(messages: readonly Message[], signal: AbortSignal) {
    for (const [index, message] of messages.entries()) {
      if (signal.aborted) {
        await this.#release(messages.slice(index));
        return;
      }
      if (index > 0) await this.#extend(message);
      const handled = await this.#options.context.run(
        { sqsMessageId: message.MessageId },
        () => this.#handle(message),
      );
      if (handled === 'backoff') {
        await this.#release(messages.slice(index + 1));
        return;
      }
    }
  }

  async #handle(message: Message): Promise<Handled> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );
    const groupId = message.Attributes?.MessageGroupId ?? 'unknown';
    const parsed = parseEnvelope(message.Body);
    if (parsed === null) {
      this.#options.logger.warn('invalid sqs envelope', {
        reason: 'VALIDATION_FAILED',
      });
      await this.#moveToDlq({
        message,
        reason: 'VALIDATION_FAILED',
        errorClass: 'permanent',
        receiveCount,
        deduplicationId: message.MessageId ?? 'unknown',
        groupId,
      });
      return 'done';
    }
    this.#options.context.set({ messageId: parsed.messageId });

    const outcome = await this.#options.process.execute({
      messageId: parsed.messageId,
      sqsMessageId: message.MessageId ?? 'unknown',
      idempotencyKey: parsed.data.idempotencyKey,
      operation: operationOf(parsed.data),
    });
    switch (outcome.kind) {
      case 'ack':
        this.#options.faults.crashAfterCommit();
        await this.#delete(message);
        return 'done';
      case 'dlq':
        await this.#moveToDlq({
          message,
          reason: outcome.reason,
          errorClass: 'permanent',
          receiveCount,
          deduplicationId: parsed.messageId,
          groupId,
        });
        return 'done';
      case 'retry': {
        const decision = decideRetry(
          outcome.errorClass,
          receiveCount,
          this.#options.settings.backoff,
        );
        if (decision.action === 'dlq') {
          await this.#moveToDlq({
            message,
            reason: decision.reason,
            errorClass: outcome.errorClass,
            receiveCount,
            deduplicationId: parsed.messageId,
            groupId,
          });
          return 'done';
        }
        this.#options.metrics.sqsRetry(outcome.errorClass);
        await this.#changeVisibility(message, decision.visibilitySeconds);
        return 'backoff';
      }
    }
  }

  async #moveToDlq(move: Parameters<SqsDlqMover['move']>[0]): Promise<void> {
    try {
      await this.#options.dlq.move(move);
      this.#options.logger.warn('message moved to the DLQ', {
        reason: move.reason,
        errorClass: move.errorClass,
        receiveCount: move.receiveCount,
      });
    } catch (error) {
      // The message stays in flight and comes back after its visibility timeout.
      this.#options.logger.warn('dlq move failed', {
        reason: move.reason,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  async #delete(message: Message): Promise<void> {
    const { sqs, guard, queues } = this.#options;
    try {
      const queueUrl = await queues.url('input');
      await guard(() =>
        sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        ),
      );
    } catch (error) {
      // Committed: the redelivery is an inbox duplicate with no second effect.
      this.#options.logger.warn('sqs delete failed', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  #extend(message: Message): Promise<void> {
    return this.#changeVisibility(
      message,
      this.#options.settings.visibilityTimeoutSeconds,
    );
  }

  async #release(messages: readonly Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) => this.#changeVisibility(message, 0)),
    );
  }

  async #changeVisibility(message: Message, seconds: number): Promise<void> {
    const { sqs, guard, queues } = this.#options;
    try {
      const queueUrl = await queues.url('input');
      await guard(() =>
        sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: seconds,
          }),
        ),
      );
    } catch (error) {
      // The message keeps its current visibility and comes back when it ends.
      this.#options.logger.warn('sqs visibility change failed', {
        seconds,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

type Envelope = ReturnType<typeof sqsEnvelope.parse>;

function parseEnvelope(body: string | undefined): Envelope | null {
  if (body === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = sqsEnvelope.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** The operation without the key, which the use case takes on its own. */
function operationOf(data: Envelope['data']): WagerMessage['operation'] {
  const { idempotencyKey: _, ...operation } = data;
  return operation;
}

/** The batch split by group, each group in SQS order, groups in first-seen order. */
function byGroup(messages: readonly Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const id = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [message]);
    else group.push(message);
  }
  return [...groups.values()];
}

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
