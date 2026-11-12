/**
 * A guided run of the main guarantees against the three instances of the
 * `app` profile (`docker compose --profile app up -d`):
 *
 *   1. contention: concurrent bets on one wallet, spread over the instances;
 *   2. replay: the same operation on every instance, and a key reused with
 *      another payload;
 *   3. out-of-order reversal: a refund before its bet, and a win after it;
 *   4. crash recovery: `SIGKILL` on one instance while SQS messages flow;
 *   5. reconciliation of every wallet the demo touched.
 *
 *   bun scripts/demo.ts [--skip-crash]
 *
 * Each step checks its outcome and prints ✓ or ✗; the exit code is the
 * number of failed checks. Identifiers carry a per-run prefix, so the demo
 * can run again on the same database. `DEMO_URLS` (comma-separated) and
 * `DEMO_CRASH_SERVICE` override the instances and the service to kill.
 */
import { parseArgs } from 'node:util';
import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import {
  loadConfig,
  queueNames,
} from '../src/infrastructure/config/app-config.js';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client.js';

type Money = { amount: string; currency: string };
type Wallet = { id: string; playerId: string; balance: Money; version: number };
type Result = {
  transactionId: string;
  status: string;
  balance: Money | null;
  failureCode?: string;
  details?: Record<string, unknown>;
  idempotentReplay: boolean;
};
type Resource = {
  id: string;
  status: string;
  details?: Record<string, unknown>;
};
type Reconciliation = {
  consistent: boolean;
  checkedEntries: number;
  issues: unknown[];
  storedBalance: Money;
};
type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

const { values: flags } = parseArgs({
  options: { 'skip-crash': { type: 'boolean', default: false } },
});
const URLS = (
  process.env.DEMO_URLS ??
  'http://localhost:3001,http://localhost:3002,http://localhost:3003'
).split(',');
const CRASH_SERVICE = process.env.DEMO_CRASH_SERVICE ?? 'app-2';
const RUN = `demo-${Date.now().toString(36)}`;
const PROVIDER = 'demo';
const wallets: string[] = [];
let failures = 0;

// ---------------------------------------------------------------- output

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

function step(title: string): void {
  console.log(`\n${bold(title)}`);
}

function note(text: string): void {
  console.log(dim(`  ${text}`));
}

function check(ok: boolean, text: string, actual?: unknown): void {
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${text}`);
    return;
  }
  failures += 1;
  const got =
    actual === undefined ? '' : ` ${dim(`(got ${JSON.stringify(actual)})`)}`;
  console.log(`  \x1b[31m✗\x1b[0m ${text}${got}`);
}

// ------------------------------------------------------------------ HTTP

const url = (instance: number) => URLS[instance % URLS.length] as string;

async function request<T>(
  instance: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  // A 503 or a refused connection is resent as is: every write here carries
  // its idempotency key, so a resend never applies twice.
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${url(instance + attempt)}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status !== 503 || Date.now() > deadline) {
        return { status: response.status, body: (await response.json()) as T };
      }
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    await Bun.sleep(200);
  }
}

async function openWallet(amount: string, instance = 0): Promise<Wallet> {
  const response = await request<Wallet>(instance, 'POST', '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  if (response.status !== 201) {
    throw new Error(`POST /wallets answered ${response.status}`);
  }
  wallets.push(response.body.id);
  return response.body;
}

type Operation = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
};

function operation(
  wallet: Wallet,
  kind: Kind,
  id: string,
  amount: string,
  reference?: string,
): Operation {
  return {
    providerId: PROVIDER,
    externalTransactionId: `${RUN}-${id}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `${RUN}-round`,
    gameId: 'slots',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference === undefined
      ? {}
      : { referenceExternalTransactionId: `${RUN}-${reference}` }),
  };
}

function wager(instance: number, op: Operation) {
  return request<Result>(instance, 'POST', '/wagering/transactions', op, {
    'idempotency-key': `${op.providerId}:${op.externalTransactionId}`,
  });
}

async function balanceOf(walletId: string, instance = 0): Promise<string> {
  const response = await request<Wallet>(
    instance,
    'GET',
    `/wallets/${walletId}`,
  );
  return response.body.balance.amount;
}

async function stored(op: Operation, instance = 0): Promise<Resource | null> {
  const response = await request<Resource>(
    instance,
    'GET',
    `/providers/${op.providerId}/wagering/transactions/${op.externalTransactionId}`,
  );
  return response.status === 200 ? response.body : null;
}

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(250);
  }
  note(`gave up waiting for ${what} after ${timeoutMs / 1000} s`);
  return undefined;
}

// ----------------------------------------------------------------- steps

async function contention(): Promise<void> {
  step('1. Contention: 20 concurrent bets of 10.00 on a wallet of 100.00');
  const wallet = await openWallet('100.00');
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      wager(i, operation(wallet, 'BET', `contention-${i}`, '10.00')),
    ),
  );
  const processed = results.filter((r) => r.body.status === 'PROCESSED');
  const rejected = results.filter(
    (r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS',
  );
  note(`sent round-robin to ${URLS.length} instances`);
  check(processed.length === 10, 'exactly 10 are processed', processed.length);
  check(
    rejected.length === 10,
    'the other 10 are rejected as INSUFFICIENT_FUNDS',
    rejected.length,
  );
  const balance = await balanceOf(wallet.id);
  check(balance === '0.00', 'the balance ends at 0.00, never below', balance);
}

async function replay(): Promise<void> {
  step('2. Replay: one bet sent to every instance at once');
  const wallet = await openWallet('100.00');
  const bet = operation(wallet, 'BET', 'replay', '30.00');
  const results = await Promise.all(URLS.map((_, i) => wager(i, bet)));
  const ids = new Set(results.map((r) => r.body.transactionId));
  check(ids.size === 1, 'every instance answers with the same transactionId', [
    ...ids,
  ]);
  check(
    results.filter((r) => !r.body.idempotentReplay).length === 1,
    'one answer is the original, the others are replays',
    results.map((r) => r.body.idempotentReplay),
  );
  const balance = await balanceOf(wallet.id);
  check(balance === '70.00', 'the wallet was debited once: 70.00', balance);

  const conflict = await wager(1, {
    ...bet,
    money: { amount: '99.00', currency: 'BRL' },
  });
  check(
    conflict.status === 409,
    'the same key with another amount answers 409',
    conflict.status,
  );
}

async function outOfOrderReversal(): Promise<void> {
  step('3. Out-of-order reversal: a refund before its bet, then a win');
  const wallet = await openWallet('100.00');
  const refund = operation(wallet, 'REFUND', 'refund', '40.00', 'late-bet');
  const early = await wager(0, refund);
  check(
    early.status === 202 && early.body.status === 'PENDING_REFERENCE',
    'the refund waits for its bet: 202 PENDING_REFERENCE',
    early.status,
  );

  const bet = operation(wallet, 'BET', 'late-bet', '40.00');
  const placed = await wager(1, bet);
  check(
    placed.body.balance?.amount === '60.00',
    'the bet arrives and debits: 60.00',
    placed.body.balance,
  );

  const decided = await until('the refund', async () => {
    const resource = await stored(refund, 2);
    return resource?.status === 'PENDING_REFERENCE' ? undefined : resource;
  });
  check(
    decided?.status === 'PROCESSED',
    'a worker applies the refund',
    decided?.status,
  );
  const balance = await balanceOf(wallet.id);
  check(balance === '100.00', 'the bet is reversed: 100.00', balance);

  const win = await wager(
    2,
    operation(wallet, 'WIN', 'win', '25.00', 'late-bet'),
  );
  check(
    win.body.status === 'PROCESSED' &&
      win.body.details?.referenceReversedBy === decided?.id,
    'a win on the refunded bet is processed and flagged with referenceReversedBy',
    win.body,
  );
}

async function crashRecovery(): Promise<void> {
  step(`4. Crash recovery: SIGKILL on ${CRASH_SERVICE} while 60 SQS bets flow`);
  if (flags['skip-crash']) {
    note('skipped (--skip-crash)');
    return;
  }
  const wallet = await openWallet('1000.00');
  const bets = Array.from({ length: 60 }, (_, i) =>
    operation(wallet, 'BET', `sqs-${i}`, '1.00'),
  );

  const config = loadConfig(process.env);
  const sqs = createSqsClient(config);
  try {
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: queueNames(config).input }),
    );
    const send = async (batch: Operation[], offset: number) => {
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl,
          Entries: batch.map((op, i) => ({
            Id: String(i),
            MessageGroupId: op.walletId,
            MessageDeduplicationId: op.externalTransactionId,
            MessageBody: JSON.stringify({
              messageId: `${op.externalTransactionId}-msg`,
              type: 'WagerTransactionRequested',
              occurredAt: new Date().toISOString(),
              data: {
                ...op,
                idempotencyKey: `${op.providerId}:${op.externalTransactionId}`,
              },
            }),
          })),
        }),
      );
      note(`sent bets ${offset}–${offset + batch.length - 1}`);
    };
    await send(bets.slice(0, 10), 0);
    await send(bets.slice(10, 20), 10);
    await compose('kill', '-s', 'SIGKILL', CRASH_SERVICE);
    // `start` is a no-op while Docker still reports the container running.
    await until(`${CRASH_SERVICE} to stop`, async () =>
      (await compose('ps', '--status', 'running', '--quiet', CRASH_SERVICE)) ===
      ''
        ? true
        : undefined,
    );
    note(`${CRASH_SERVICE} killed`);
    for (let offset = 20; offset < bets.length; offset += 10) {
      await send(bets.slice(offset, offset + 10), offset);
    }
    await compose('start', CRASH_SERVICE);
    note(`${CRASH_SERVICE} restarted`);
  } finally {
    sqs.destroy();
  }

  const done = await until(
    'all 60 bets',
    async () => {
      const resources = await Promise.all(bets.map((op, i) => stored(op, i)));
      return resources.every((r) => r?.status === 'PROCESSED')
        ? true
        : undefined;
    },
    90_000,
  );
  check(
    done === true,
    'every bet is processed, none lost with the killed instance',
  );
  const balance = await balanceOf(wallet.id);
  check(balance === '940.00', 'each bet was applied once: 940.00', balance);

  const ready = await until('every instance', async () => {
    const answers = await Promise.all(
      URLS.map((base) => fetch(`${base}/health/ready`).catch(() => null)),
    );
    return answers.every((r) => r?.ok === true) ? true : undefined;
  });
  check(ready === true, `${CRASH_SERVICE} is back and every instance is ready`);
}

async function reconciliation(): Promise<void> {
  step(`5. Reconciliation of the ${wallets.length} wallets above`);
  const reports = await Promise.all(
    wallets.map((id, i) =>
      request<Reconciliation>(i, 'POST', `/wallets/${id}/reconciliation`),
    ),
  );
  const inconsistent = reports.filter((r) => !r.body.consistent);
  const entries = reports.reduce((sum, r) => sum + r.body.checkedEntries, 0);
  note(`${entries} ledger entries checked`);
  check(
    inconsistent.length === 0,
    'every stored balance equals its ledger, with no version or chain issue',
    inconsistent.map((r) => r.body.issues),
  );
}

/** Runs `docker compose --profile app …` and returns its trimmed stdout. */
async function compose(...args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', 'compose', '--profile', 'app', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout.trim();
}

// ------------------------------------------------------------------ main

for (const base of URLS) {
  const response = await fetch(`${base}/health/ready`).catch(() => null);
  if (response?.ok !== true) {
    console.error(
      `${base} is not ready; start the instances with: docker compose --profile app up -d`,
    );
    process.exit(1);
  }
}
console.log(`run ${RUN} against ${URLS.join(', ')}`);

await contention();
await replay();
await outOfOrderReversal();
await crashRecovery();
await reconciliation();

console.log(
  failures === 0
    ? `\n${bold('All checks passed.')}`
    : `\n${bold(`${failures} check(s) failed.`)}`,
);
process.exit(failures);
