import { isDeepStrictEqual } from 'node:util';
import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import type { SetupResult } from '../setup.js';
import { OPENING, type Profile, type Workload, workloads } from './workload.js';

export type Settings = {
  profile: Profile;
  rate: number;
  seconds: number;
  vus: number;
  seed: number;
  wallets: number;
  mix: Workload[];
  maxP95Ms: number | null;
  maxDropped: number | null;
  drainSeconds: number;
};

type Wallet = { id: string; playerId: string };
type Expected = {
  walletId: string;
  kind: string;
  delta: bigint;
  pending: boolean;
  failure: string | null;
  reference: string | null;
};

export type Event = {
  eventId: string;
  eventType: string;
  data: { transactionId: string; walletId: string };
};

export function requireCondition(
  value: unknown,
  diagnostic: string,
): asserts value {
  if (!value) throw new Error(diagnostic);
}

export class LoadEvents {
  readonly received = new Map<
    string,
    { body: string; event: Event; group: string | undefined }
  >();
  duplicates = 0;
  error: unknown;
  #stopped = false;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  stop() {
    this.#stopped = true;
  }

  async read() {
    try {
      while (!this.#stopped) {
        const { Messages = [] } = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            MessageSystemAttributeNames: ['MessageGroupId'],
          }),
        );
        if (Messages.length === 0) continue;
        for (const message of Messages) {
          const body = message.Body ?? '';
          const event = JSON.parse(body) as Event;
          const group = message.Attributes?.MessageGroupId;
          const first = this.received.get(event.eventId);
          if (first) {
            requireCondition(
              first.body === body && first.group === group,
              `Conflicting event copy ${event.eventId}`,
            );
            this.duplicates += 1;
          } else this.received.set(event.eventId, { body, event, group });
        }
        const deleted = await this.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: Messages.map(({ ReceiptHandle }, index) => ({
              Id: String(index),
              ReceiptHandle,
            })),
          }),
        );
        requireCondition(
          !deleted.Failed?.length,
          'Events could not be acknowledged',
        );
      }
    } catch (error) {
      this.error = error;
    }
  }
}

export async function depth(sqs: SQSClient, QueueUrl: string) {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  return Object.values(Attributes ?? {}).reduce(
    (total, count) => total + Number(count),
    0,
  );
}

async function drain(
  sql: SQL,
  sqs: SQSClient,
  queues: SetupResult['queueUrls'],
  reader: LoadEvents,
  deadlineMs: number,
) {
  const start = performance.now();
  let state;
  do {
    if (reader.error !== undefined)
      throw new Error('Event reader failed', { cause: reader.error });
    const [row] = (await sql`
      SELECT
        (SELECT count(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE') AS pending,
        (SELECT count(*)::int FROM outbox WHERE published_at IS NULL) AS unpublished,
        (SELECT count(*)::int FROM outbox) AS events
    `) as { pending: number; unpublished: number; events: number }[];
    const [input, deadLetter, eventsQueue] = await Promise.all([
      depth(sqs, queues.input),
      depth(sqs, queues.deadLetter),
      depth(sqs, queues.events),
    ]);
    state = {
      ...row,
      input,
      deadLetter,
      eventsQueue,
      received: reader.received.size,
    };
    requireCondition(deadLetter === 0, `DLQ depth ${deadLetter}`);
    if (
      row?.pending === 0 &&
      row.unpublished === 0 &&
      input === 0 &&
      eventsQueue === 0 &&
      row.events === reader.received.size
    )
      return { ...state, drainMs: performance.now() - start };
    await Bun.sleep(100);
  } while (performance.now() - start < deadlineMs);
  throw new Error(`Drain deadline exceeded ${JSON.stringify(state)}`);
}

function minor(amount: string): bigint {
  requireCondition(
    /^\d+\.\d{2}$/.test(amount),
    'Expected a decimal string from PostgreSQL',
  );
  return BigInt(amount.replace('.', ''));
}

function expectedOperations(
  settings: Settings,
  wallets: Wallet[],
  count: number,
) {
  const operations = new Map<string, Expected>();
  const hot = settings.profile === 'hot' || settings.profile === 'saturation';
  for (let index = 0; index < count; index += 1) {
    const seed = (index + settings.seed) >>> 0;
    const name = settings.mix[seed % settings.mix.length];
    const walletIndex = hot
      ? seed % 5 === 0
        ? 1 + (Math.floor(seed / 5) % (wallets.length - 1))
        : 0
      : (Math.imul(seed, 2654435761) >>> 0) % wallets.length;
    const wallet = wallets[walletIndex];
    requireCondition(name && wallet, 'Invalid workload assignment');
    const prefix = `${name}-${index}`;
    for (const step of workloads[
      name
    ] as readonly import('./workload.js').LoadStep[]) {
      operations.set(`${prefix}-${step.id}`, {
        walletId: wallet.id,
        kind: step.kind,
        delta: BigInt(step.delta),
        pending: step.response === 202,
        failure: step.failure ?? null,
        reference: step.reference ? `${prefix}-${step.reference}` : null,
      });
    }
  }
  return operations;
}

type VerificationOptions = {
  sql: SQL;
  sqs: SQSClient;
  queues: SetupResult['queueUrls'];
  reader: LoadEvents;
  settings: Settings;
  wallets: Wallet[];
  count: number;
  targets: string[];
  runId: string;
};

export async function verifyLoad(options: VerificationOptions) {
  const { sql, sqs, queues, reader, settings, wallets, count, targets, runId } =
    options;
  const drained = await drain(
    sql,
    sqs,
    queues,
    reader,
    settings.drainSeconds * 1000,
  );
  const expected = expectedOperations(settings, wallets, count);
  const transactions = (await sql`
    SELECT id, wallet_id, kind, status, failure_code, provider_id, external_transaction_id,
      reference_external_transaction_id, reference_transaction_id,
      result_balance_amount::text, result_balance_currency FROM wager_transactions
  `) as {
    id: string;
    wallet_id: string;
    kind: string;
    status: string;
    failure_code: string | null;
    provider_id: string | null;
    external_transaction_id: string | null;
    reference_external_transaction_id: string | null;
    reference_transaction_id: string | null;
    result_balance_amount: string;
    result_balance_currency: string;
  }[];
  const byExternal = new Map(
    transactions.map((row) => [row.external_transaction_id, row]),
  );
  requireCondition(
    transactions.length === expected.size + wallets.length,
    `Expected ${expected.size + wallets.length} transactions, found ${transactions.length}`,
  );

  const wantedEvents = new Map<string, Set<string>>();
  const deltas = new Map<string, bigint>();
  const expectedBalances = new Map(
    wallets.map(({ id }) => [id, minor(OPENING)]),
  );
  for (const tx of transactions) {
    const opening = tx.kind === 'OPENING';
    const external = tx.external_transaction_id;
    const op = external === null ? undefined : expected.get(external);
    requireCondition(
      opening ||
        (op &&
          tx.provider_id === runId &&
          tx.wallet_id === op.walletId &&
          tx.kind === op.kind),
      `Unexpected transaction ${tx.id}`,
    );
    const status = op?.failure ? 'REJECTED' : 'PROCESSED';
    requireCondition(
      tx.status === status &&
        tx.failure_code === (op?.failure ?? null) &&
        tx.result_balance_currency === 'BRL',
      `Unexpected result for ${tx.id}`,
    );
    const reference = op?.reference ?? null;
    requireCondition(
      tx.reference_external_transaction_id === reference &&
        tx.reference_transaction_id ===
          (reference === null ? null : byExternal.get(reference)?.id),
      `Unexpected reference for ${tx.id}`,
    );
    const delta = opening ? minor(OPENING) : (op?.delta ?? 0n);
    deltas.set(tx.id, delta);
    const events = new Set([
      op?.failure ? 'WagerTransactionRejected' : 'WagerTransactionProcessed',
    ]);
    if (delta !== 0n) events.add('WalletBalanceChanged');
    if (op?.pending) events.add('WagerTransactionPendingReference');
    wantedEvents.set(tx.id, events);
    if (!opening) {
      const prior = expectedBalances.get(tx.wallet_id);
      requireCondition(prior !== undefined, `Unexpected wallet for ${tx.id}`);
      expectedBalances.set(tx.wallet_id, prior + delta);
    }
  }

  const outbox =
    (await sql`SELECT id, wallet_id, event_type, payload FROM outbox`) as {
      id: string;
      wallet_id: string;
      event_type: string;
      payload: Event;
    }[];
  const txById = new Map(transactions.map((row) => [row.id, row]));
  for (const row of outbox) {
    const event = row.payload;
    const tx = txById.get(event.data.transactionId);
    const delivery = reader.received.get(row.id);
    requireCondition(
      event.eventId === row.id &&
        event.eventType === row.event_type &&
        tx?.wallet_id === row.wallet_id &&
        event.data.walletId === row.wallet_id &&
        wantedEvents.get(event.data.transactionId)?.delete(row.event_type) &&
        delivery?.group === row.wallet_id &&
        isDeepStrictEqual(delivery.event, event),
      `Unexpected outbox or delivery for event ${row.id}`,
    );
  }
  requireCondition(
    [...wantedEvents.values()].every((set) => set.size === 0),
    'Missing required events',
  );

  const entries = (await sql`
    SELECT wallet_id, transaction_id, direction, amount::text, balance_before::text,
      balance_after::text, wallet_version, currency FROM wallet_ledger_entries ORDER BY wallet_id, wallet_version
  `) as {
    wallet_id: string;
    transaction_id: string;
    direction: string;
    amount: string;
    balance_before: string;
    balance_after: string;
    wallet_version: number;
    currency: string;
  }[];
  const totals = new Map<string, { balance: bigint; version: number }>();
  const recorded = new Set<string>();
  for (const entry of entries) {
    const state = totals.get(entry.wallet_id) ?? { balance: 0n, version: 0 };
    const amount = minor(entry.amount);
    const delta = entry.direction === 'DEBIT' ? -amount : amount;
    const tx = txById.get(entry.transaction_id);
    requireCondition(
      tx?.wallet_id === entry.wallet_id &&
        entry.currency === 'BRL' &&
        (entry.direction === 'DEBIT' || entry.direction === 'CREDIT') &&
        amount > 0n &&
        deltas.get(entry.transaction_id) === delta &&
        !recorded.has(entry.transaction_id) &&
        state.balance === minor(entry.balance_before) &&
        entry.wallet_version === state.version + 1,
      `Invalid ledger entry for ${entry.transaction_id}`,
    );
    state.balance += delta;
    state.version += 1;
    requireCondition(
      state.balance >= 0n &&
        state.balance === minor(entry.balance_after) &&
        state.balance === minor(tx.result_balance_amount),
      `Wrong balance for ${entry.transaction_id}`,
    );
    totals.set(entry.wallet_id, state);
    recorded.add(entry.transaction_id);
  }
  requireCondition(
    [...deltas].every(([id, delta]) => recorded.has(id) === (delta !== 0n)),
    'Ledger effects differ from the workload',
  );
  const storedWallets =
    (await sql`SELECT id, balance::text, version FROM wallets`) as {
      id: string;
      balance: string;
      version: number;
    }[];
  requireCondition(
    storedWallets.length === wallets.length,
    'Unexpected wallet count',
  );
  for (const [index, wallet] of storedWallets.entries()) {
    const state = totals.get(wallet.id);
    requireCondition(
      state &&
        state.balance === expectedBalances.get(wallet.id) &&
        state.balance === minor(wallet.balance) &&
        state.version === wallet.version,
      `Wrong wallet tip ${wallet.id}`,
    );
    const response = await fetch(
      `${targets[index % targets.length]}/wallets/${wallet.id}/reconciliation`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    );
    const result = (await response.json()) as {
      consistent: boolean;
      checkedEntries: number;
    };
    requireCondition(
      response.ok &&
        result.consistent &&
        result.checkedEntries === state.version,
      `Reconciliation failed for ${wallet.id}`,
    );
  }
  return {
    ...drained,
    workloads: count,
    wallets: wallets.length,
    operations: expected.size,
    processed: transactions.filter(
      (tx) => tx.kind !== 'OPENING' && tx.status === 'PROCESSED',
    ).length,
    rejected: transactions.filter((tx) => tx.status === 'REJECTED').length,
    ledgerEntries: entries.length,
    duplicateDeliveries: reader.duplicates,
  };
}
