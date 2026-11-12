/**
 * `scripts/redrive-dlq.ts` against the spec's own queues and a spawned
 * consumer: only redrivable reasons move, the rest stay in the DLQ and
 * visible, and a redriven operation is applied once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  type RedrivableReason,
  redriveDlq,
} from '../../scripts/redrive-dlq.js';
import { openWallet, type Wallet, walletOf } from '../support/cluster.js';
import { type WagerBody, wagerBody } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { type Envelope, envelopeOf, TestQueues } from '../support/sqs.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('redrive-dlq');

let app: SpawnedApp;
let http: HttpClient;
let queues: TestQueues;
const opened: string[] = [];

beforeAll(async () => {
  app = await spawnApp({ env: infrastructure.env });
  http = new HttpClient(app.baseUrl);
  queues = new TestQueues(infrastructure);
});

afterAll(async () => {
  await expectReconciled(http, opened);
  await app.stop();
});

async function open(): Promise<Wallet> {
  const wallet = await openWallet(http, '100.00');
  opened.push(wallet.id);
  return wallet;
}

/** Puts a message straight into the DLQ, as the consumer's DLQ path would. */
async function deadLetter(
  body: Envelope | string,
  groupId: string,
  failureReason?: string,
): Promise<void> {
  await infrastructure.sqs.send(
    new SendMessageCommand({
      QueueUrl: infrastructure.queueUrls.deadLetter,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
      ...(failureReason === undefined
        ? {}
        : {
            MessageAttributes: {
              failureReason: { DataType: 'String', StringValue: failureReason },
            },
          }),
    }),
  );
}

function redrive(reasons: RedrivableReason[], dryRun = false) {
  return redriveDlq({
    sqs: infrastructure.sqs,
    deadLetterQueueUrl: infrastructure.queueUrls.deadLetter,
    inputQueueUrl: infrastructure.queueUrls.input,
    reasons: new Set(reasons),
    dryRun,
    visibilityTimeoutSeconds: 30,
  });
}

/** Waits until the operation is stored, and returns its status. */
function statusOf(body: WagerBody): Promise<string> {
  return waitFor(
    async () => {
      const response = await http.get<{ status: string }>(
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );
      return response.status === 200 ? response.body.status : undefined;
    },
    {
      timeoutMs: 15_000,
      intervalMs: 200,
      description: 'the redriven operation',
    },
  );
}

/** Waits until the DLQ holds exactly `count` visible messages. */
function dlqHolds(count: number): Promise<boolean> {
  return waitFor(
    async () => {
      const counts = await queues.counts('deadLetter');
      return counts.visible === count && counts.inFlight === 0;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 200,
      description: `${count} DLQ messages`,
    },
  );
}

const reasonOf = (item: { failureReason: string | undefined }) =>
  item.failureReason ?? 'none';
const byText = (a: string, b: string) => a.localeCompare(b);

describe('redrive-dlq', () => {
  let budget: { wallet: Wallet; body: WagerBody };
  let unexpected: { wallet: Wallet; body: WagerBody };

  beforeAll(async () => {
    const budgetWallet = await open();
    budget = { wallet: budgetWallet, body: wagerBody(budgetWallet) };
    const unexpectedWallet = await open();
    unexpected = {
      wallet: unexpectedWallet,
      body: wagerBody(unexpectedWallet),
    };
    const nativeWallet = await open();

    // One group each, so no message hides another.
    await deadLetter(
      envelopeOf(budget.body),
      budget.wallet.id,
      'RETRY_BUDGET_EXHAUSTED',
    );
    await deadLetter(
      envelopeOf(unexpected.body),
      unexpected.wallet.id,
      'UNEXPECTED_ERROR',
    );
    await deadLetter('not json', 'invalid', 'VALIDATION_FAILED');
    await deadLetter(envelopeOf(wagerBody(nativeWallet)), nativeWallet.id);
  });

  it('moves nothing on a dry run, and leaves every message visible', async () => {
    const report = await redrive(['RETRY_BUDGET_EXHAUSTED'], true);

    expect(report.redriven.map((item) => item.failureReason)).toEqual([
      'RETRY_BUDGET_EXHAUSTED',
    ]);
    expect(report.skipped.map(reasonOf).sort(byText)).toEqual([
      'none',
      'UNEXPECTED_ERROR',
      'VALIDATION_FAILED',
    ]);
    expect(await dlqHolds(4)).toBe(true);
    expect((await queues.counts('input')).visible).toBe(0);
  });

  it('redrives a spent retry budget by default, in its group, and the consumer applies it', async () => {
    const report = await redrive(['RETRY_BUDGET_EXHAUSTED']);

    expect(report.redriven).toEqual([
      expect.objectContaining({
        groupId: budget.wallet.id,
        failureReason: 'RETRY_BUDGET_EXHAUSTED',
      }),
    ]);
    expect(report.skipped).toHaveLength(3);
    expect(await statusOf(budget.body)).toBe('PROCESSED');
    expect((await walletOf(http, budget.wallet.id)).balance.amount).toBe(
      '75.00',
    );
    expect(await dlqHolds(3)).toBe(true);
  });

  it('redrives an unexpected error only when asked, and never a permanent or native move', async () => {
    const report = await redrive([
      'RETRY_BUDGET_EXHAUSTED',
      'UNEXPECTED_ERROR',
    ]);

    expect(report.redriven.map((item) => item.failureReason)).toEqual([
      'UNEXPECTED_ERROR',
    ]);
    expect(report.skipped.map(reasonOf).sort(byText)).toEqual([
      'none',
      'VALIDATION_FAILED',
    ]);
    expect(await statusOf(unexpected.body)).toBe('PROCESSED');
    expect(await dlqHolds(2)).toBe(true);
  });

  it('gives a second copy of a redriven operation no second effect', async () => {
    await deadLetter(
      envelopeOf(budget.body),
      budget.wallet.id,
      'RETRY_BUDGET_EXHAUSTED',
    );

    const report = await redrive(['RETRY_BUDGET_EXHAUSTED']);

    expect(report.redriven).toHaveLength(1);
    await queues.drained();
    expect((await walletOf(http, budget.wallet.id)).balance.amount).toBe(
      '75.00',
    );
    expect(await dlqHolds(2)).toBe(true);
  });
});
