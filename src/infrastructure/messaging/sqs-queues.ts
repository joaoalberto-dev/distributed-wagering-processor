import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { CallGuard } from '../persistence/mikro-orm-unit-of-work.js';

export type QueueRole = 'input' | 'deadLetter' | 'events';

/**
 * The queue URLs, looked up by name on first use and kept. A failed lookup
 * is not kept, so an instance that boots while SQS is down finds its queues
 * once SQS is back, without a restart.
 */
export class SqsQueues {
  readonly #urls = new Map<QueueRole, Promise<string>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly guard: CallGuard,
    private readonly names: Readonly<Record<QueueRole, string>>,
  ) {}

  url(role: QueueRole): Promise<string> {
    const known = this.#urls.get(role);
    if (known !== undefined) return known;
    const lookup = this.#lookup(this.names[role]).catch((error: unknown) => {
      this.#urls.delete(role);
      throw error;
    });
    this.#urls.set(role, lookup);
    return lookup;
  }

  async #lookup(name: string): Promise<string> {
    const { QueueUrl } = await this.guard(() =>
      this.sqs.send(new GetQueueUrlCommand({ QueueName: name })),
    );
    if (QueueUrl === undefined) throw new Error(`queue ${name} has no URL`);
    return QueueUrl;
  }
}
