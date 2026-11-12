import { beforeEach, describe, expect, it } from 'bun:test';
import type { InMemoryStore } from '../../../test/support/fakes/in-memory-repositories.js';
import { InMemoryUnitOfWork } from '../../../test/support/fakes/in-memory-unit-of-work.js';
import { RecordingLogger } from '../../../test/support/fakes/recording-logger.js';
import { RecordingTelemetry } from '../../../test/support/fakes/recording-telemetry.js';
import { SequentialIds } from '../../../test/support/fakes/sequential-ids.js';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { Money } from '../../domain/money/money.js';
import { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  ExternalTransactionIdConflict,
  IdempotencyKeyConflict,
  MessageIdConflict,
  WalletNotFound,
} from '../errors.js';
import { payloadHash } from '../idempotency/payload-hash.js';
import type {
  LogFieldUpdate,
  LogFields,
  RequestContext,
} from '../ports/request-context.js';
import type {
  TxContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../ports/unit-of-work.js';
import {
  type SubmitCommand,
  SubmitWagerTransaction,
  type WagerOperation,
} from './submit-wager-transaction.js';

const WALLET = 'aaaaaaaa-0000-7000-8000-000000000000';
const PLAYER = 'bbbbbbbb-0000-7000-8000-000000000000';
const OTHER_PLAYER = 'bbbbbbbb-0000-7000-8000-000000000001';
const UNKNOWN_WALLET = 'aaaaaaaa-0000-7000-8000-00000000ffff';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/**
 * The fake unit of work, with a hook on a given run and a record of the
 * wallet locks, to place races between the unlocked lookup and the lock.
 */
class ScriptedUnitOfWork implements UnitOfWork {
  readonly locks: string[] = [];
  readonly hooks = new Map<number, (store: InMemoryStore) => void>();
  runs = 0;

  constructor(readonly inner: InMemoryUnitOfWork) {}

  run<T>(
    fn: (tx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    this.runs += 1;
    const hook = this.hooks.get(this.runs);
    if (hook !== undefined) this.inner.beforeCommit = hook;
    return this.inner.run((tx) => fn(this.spy(tx)), options);
  }

  private spy(tx: TxContext): TxContext {
    const wallets = tx.wallets;
    return {
      ...tx,
      wallets: {
        lock: (id, mode) => {
          this.locks.push(id);
          return wallets.lock(id, mode);
        },
        findById: (id) => wallets.findById(id),
        findByPlayerAndCurrency: (p, c) =>
          wallets.findByPlayerAndCurrency(p, c),
        insert: (w) => wallets.insert(w),
        save: (w) => wallets.save(w),
      },
    };
  }
}

class FakeRequestContext implements RequestContext {
  fields: LogFields = {};
  run<T>(_fields: LogFieldUpdate, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  get(): LogFields {
    return this.fields;
  }
  set(fields: LogFieldUpdate): void {
    this.fields = { ...this.fields, ...(fields as LogFields) };
  }
}

let inner: InMemoryUnitOfWork;
let uow: ScriptedUnitOfWork;
let telemetry: RecordingTelemetry;
let logger: RecordingLogger;
let context: FakeRequestContext;
let submit: SubmitWagerTransaction;

beforeEach(() => {
  inner = new InMemoryUnitOfWork();
  uow = new ScriptedUnitOfWork(inner);
  telemetry = new RecordingTelemetry();
  logger = new RecordingLogger();
  context = new FakeRequestContext();
  const ids = new SequentialIds();
  submit = new SubmitWagerTransaction(
    uow,
    inner.clock,
    ids,
    telemetry,
    logger,
    { authorize: () => Promise.resolve() },
    context,
    { referenceTtlMs: 86_400_000 },
  );
  const wallet = Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: brl('100.00'),
    at: inner.clock.now(),
  });
  inner.store.wallets.set(WALLET, wallet.toState());
});

let sequence = 0;

function operation(overrides: Partial<WagerOperation> = {}): WagerOperation {
  sequence += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function command(
  op: WagerOperation,
  overrides: Partial<SubmitCommand> = {},
): SubmitCommand {
  const key = `${op.providerId}:${op.externalTransactionId}`;
  return {
    operation: op,
    idempotencyKey: key,
    channel: 'http',
    correlationId: 'correlation-1',
    causationId: key,
    ...overrides,
  };
}

function sqs(
  op: WagerOperation,
  messageId = `msg-${op.externalTransactionId}`,
): SubmitCommand {
  return command(op, {
    channel: 'sqs',
    correlationId: messageId,
    causationId: messageId,
    inbox: { consumerName: 'wager-transactions-consumer', messageId },
  });
}

const balance = () => inner.store.wallets.get(WALLET)?.balance.toProps().amount;
const eventTypes = () =>
  [...inner.store.outbox.values()].map((m) => m.eventType);

/** A committed operation stored directly, as another submission would leave it. */
function storeCommitted(
  store: InMemoryStore,
  op: WagerOperation,
  id: string,
  key: string,
): void {
  const transaction = WagerTransaction.create({
    id,
    providerId: op.providerId,
    externalTransactionId: op.externalTransactionId,
    idempotencyKey: key,
    payloadHash: payloadHash(op),
    walletId: op.walletId,
    playerId: op.playerId,
    roundId: op.roundId,
    gameId: op.gameId,
    kind: op.kind,
    money: Money.from(op.money),
    correlationId: 'correlation-0',
    at: inner.clock.now(),
  });
  transaction.markRejected({
    failureCode: 'INSUFFICIENT_FUNDS',
    balance: brl('100.00'),
    at: inner.clock.now(),
  });
  store.transactions.set(id, transaction.toState());
}

describe('SubmitWagerTransaction', () => {
  describe('the §8 decision table', () => {
    it('proceeds when neither the key nor the external ID is stored', async () => {
      const result = await submit.execute(command(operation()));
      expect(result.replay).toBe(false);
      expect(result.transaction).toMatchObject({
        status: 'PROCESSED',
        resultBalance: { amount: '75.00', currency: 'BRL' },
        failureCode: null,
      });
      expect(balance()).toBe('75.00');
      expect(telemetry.of('transactionDecided')).toEqual([
        ['BET', 'PROCESSED', 'http'],
      ]);
      expect(telemetry.of('processingDuration')).toHaveLength(1);
    });

    it('replays the stored result for the same key and payload, with no new write', async () => {
      const op = operation();
      const first = await submit.execute(command(op));
      const rows = inner.store.transactions.size;
      const replay = await submit.execute(command(op));
      expect(replay).toEqual({ ...first, replay: true });
      expect(inner.store.transactions.size).toBe(rows);
      expect(balance()).toBe('75.00');
      expect(telemetry.of('idempotentReplay')).toEqual([['http']]);
    });

    it('refuses the same key with another payload: IDEMPOTENCY_KEY_CONFLICT', async () => {
      const op = operation();
      await submit.execute(command(op));
      const error = await rejectionOf(
        submit.execute(
          command({ ...op, money: { amount: '26.00', currency: 'BRL' } }),
        ),
      );
      expect(error).toBeInstanceOf(IdempotencyKeyConflict);
      expect(telemetry.of('idempotencyConflict')).toEqual([
        ['IDEMPOTENCY_KEY_CONFLICT'],
      ]);
    });

    it('refuses a stored external ID under a new key, even with the identical payload', async () => {
      const op = operation();
      await submit.execute(command(op));
      const error = await rejectionOf(
        submit.execute(command(op, { idempotencyKey: 'another-key' })),
      );
      expect(error).toBeInstanceOf(ExternalTransactionIdConflict);
      expect(telemetry.of('idempotencyConflict')).toEqual([
        ['EXTERNAL_TRANSACTION_ID_CONFLICT'],
      ]);
    });
  });

  describe('replays', () => {
    it('take the status from the stored state when served', async () => {
      const op = operation({
        kind: 'WIN',
        referenceExternalTransactionId: 'ext-missing',
      });
      const first = await submit.execute(command(op));
      expect(first.transaction.status).toBe('PENDING_REFERENCE');
      expect(first.transaction.resultBalance).toBeNull();

      // The worker decides it later.
      const stored = inner.store.transactions.get(first.transaction.id);
      if (stored === undefined) throw new Error('missing');
      const decided = WagerTransaction.rehydrate(stored);
      decided.markRejected({
        failureCode: 'REFERENCE_NOT_FOUND',
        balance: brl('100.00'),
        at: inner.clock.now(),
      });
      inner.store.transactions.set(decided.id, decided.toState());

      const replay = await submit.execute(command(op));
      expect(replay.transaction).toMatchObject({
        id: first.transaction.id,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_FOUND',
      });
    });

    it('of a pending operation take no lock and do not try to resolve the reference', async () => {
      const op = operation({
        kind: 'WIN',
        referenceExternalTransactionId: 'ext-later',
      });
      await submit.execute(command(op));
      // The reference arrives, but the replay must not settle the pending operation.
      await submit.execute(
        command(operation({ externalTransactionId: 'ext-later' })),
      );
      const locks = uow.locks.length;
      const runs = uow.runs;

      const replay = await submit.execute(command(op));
      expect(replay.replay).toBe(true);
      expect(replay.transaction.status).toBe('PENDING_REFERENCE');
      expect(uow.locks.length).toBe(locks);
      expect(uow.runs).toBe(runs + 1);
    });
  });

  describe('events per outcome', () => {
    it('a processed debit: the transaction event and WalletBalanceChanged', async () => {
      await submit.execute(command(operation()));
      expect(eventTypes()).toEqual([
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
    });

    it('a LOSS: the transaction event only, no entry, no version change', async () => {
      await submit.execute(
        command(
          operation({
            kind: 'LOSS',
            money: { amount: '0.00', currency: 'BRL' },
          }),
        ),
      );
      expect(eventTypes()).toEqual(['WagerTransactionProcessed']);
      expect(inner.store.ledger.size).toBe(0);
      expect(inner.store.wallets.get(WALLET)?.version).toBe(1);
    });

    it('a rejection: WagerTransactionRejected, persisted with the snapshot', async () => {
      const result = await submit.execute(
        command(operation({ money: { amount: '100.01', currency: 'BRL' } })),
      );
      expect(result.transaction).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        resultBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(eventTypes()).toEqual(['WagerTransactionRejected']);
    });

    it('a wait: WagerTransactionPendingReference', async () => {
      await submit.execute(
        command(
          operation({
            kind: 'REFUND',
            referenceExternalTransactionId: 'ext-x',
          }),
        ),
      );
      expect(eventTypes()).toEqual(['WagerTransactionPendingReference']);
      expect(inner.store.pending.size).toBe(1);
    });
  });

  describe('domain checks', () => {
    it('raises WalletNotFound for an unknown wallet and stores nothing', async () => {
      const error = await rejectionOf(
        submit.execute(command(operation({ walletId: UNKNOWN_WALLET }))),
      );
      expect(error).toBeInstanceOf(WalletNotFound);
      expect(inner.store.transactions.size).toBe(0);
    });

    it('rejects another player and another currency', async () => {
      const player = await submit.execute(
        command(operation({ playerId: OTHER_PLAYER })),
      );
      expect(player.transaction.failureCode).toBe('WALLET_PLAYER_MISMATCH');
      const currency = await submit.execute(
        command(operation({ money: { amount: '1.00', currency: 'USD' } })),
      );
      expect(currency.transaction.failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('records the resolved reference of a processed settlement', async () => {
      const bet = await submit.execute(
        command(operation({ externalTransactionId: 'ext-bet' })),
      );
      const win = await submit.execute(
        command(
          operation({ kind: 'WIN', referenceExternalTransactionId: 'ext-bet' }),
        ),
      );
      expect(win.transaction).toMatchObject({
        status: 'PROCESSED',
        referenceTransactionId: bet.transaction.id,
      });
      expect(balance()).toBe('100.00');
    });

    it('reverses a BET with a ROLLBACK through the reference entry', async () => {
      await submit.execute(
        command(operation({ externalTransactionId: 'ext-rb' })),
      );
      const rollback = await submit.execute(
        command(
          operation({
            kind: 'ROLLBACK',
            referenceExternalTransactionId: 'ext-rb',
          }),
        ),
      );
      expect(rollback.transaction.status).toBe('PROCESSED');
      expect(balance()).toBe('100.00');
    });

    it('warns when a settlement lands on a reversed BET', async () => {
      await submit.execute(
        command(operation({ externalTransactionId: 'ext-rv' })),
      );
      const refund = await submit.execute(
        command(
          operation({
            kind: 'REFUND',
            referenceExternalTransactionId: 'ext-rv',
          }),
        ),
      );
      const win = await submit.execute(
        command(
          operation({ kind: 'WIN', referenceExternalTransactionId: 'ext-rv' }),
        ),
      );
      expect(win.transaction.details).toEqual({
        referenceReversedBy: refund.transaction.id,
      });
      expect(logger.warnings.map((w) => w.message)).toEqual([
        'settled against a reversed reference',
      ]);
    });
  });

  describe('races', () => {
    it('replays when the same operation commits first (identity race), after one re-read', async () => {
      const op = operation();
      const key = `${op.providerId}:${op.externalTransactionId}`;
      // Run 2 is the decision: another request commits the same operation before it.
      uow.hooks.set(2, (working) => {
        storeCommitted(inner.store, op, 'winner', key);
        storeCommitted(working, op, 'winner', key);
      });
      const result = await submit.execute(command(op));
      expect(result.replay).toBe(true);
      expect(result.transaction.id).toBe('winner');
      expect(telemetry.of('uniqueViolationRetry')).toHaveLength(1);
      expect(balance()).toBe('100.00');
    });

    it('answers a conflict when the race winner used the key with another payload', async () => {
      const op = operation();
      const key = `${op.providerId}:${op.externalTransactionId}`;
      const other = { ...op, money: { amount: '1.00', currency: 'BRL' } };
      uow.hooks.set(2, (working) => {
        storeCommitted(inner.store, other, 'winner', key);
        storeCommitted(working, other, 'winner', key);
      });
      expect(await rejectionOf(submit.execute(command(op)))).toBeInstanceOf(
        IdempotencyKeyConflict,
      );
    });

    it('replays an operation found under the lock and rolls back the decision', async () => {
      const op = operation();
      // Run 1 is the unlocked lookup: the operation commits right after it.
      uow.hooks.set(1, (working) => {
        storeCommitted(
          working,
          op,
          'earlier',
          `${op.providerId}:${op.externalTransactionId}`,
        );
      });
      const result = await submit.execute(command(op));
      expect(result).toMatchObject({
        replay: true,
        transaction: { id: 'earlier' },
      });
      expect(telemetry.of('uniqueViolationRetry')).toHaveLength(0);
      expect(inner.store.transactions.size).toBe(1);
      expect(balance()).toBe('100.00');
    });
  });

  describe('SQS', () => {
    it('records the inbox row with the effect, without contention retries', async () => {
      const result = await submit.execute(sqs(operation()));
      const [row] = [...inner.store.inbox.values()];
      expect(row).toMatchObject({
        consumerName: 'wager-transactions-consumer',
        transactionId: result.transaction.id,
      });
      expect(inner.runs.every((r) => !r.retryContention)).toBe(true);
    });

    it('acknowledges a repeated delivery as a duplicate', async () => {
      const op = operation();
      const first = await submit.execute(sqs(op));
      const again = await submit.execute(sqs(op));
      expect(again).toEqual({ ...first, replay: true, duplicate: true });
      expect(inner.store.inbox.size).toBe(1);
      expect(telemetry.of('idempotentReplay')).toHaveLength(0);
    });

    it('refuses a messageId reused for another operation', async () => {
      await submit.execute(sqs(operation(), 'msg-shared'));
      const error = await rejectionOf(
        submit.execute(sqs(operation(), 'msg-shared')),
      );
      expect(error).toBeInstanceOf(MessageIdConflict);
    });

    it('records a replay of an HTTP operation in the short replay transaction', async () => {
      const op = operation();
      const http = await submit.execute(command(op));
      const replay = await submit.execute(sqs(op));
      expect(replay).toMatchObject({ replay: true, duplicate: false });
      const [row] = [...inner.store.inbox.values()];
      expect(row?.transactionId).toBe(http.transaction.id);
    });

    it('records the existing transaction when the operation is found under the lock', async () => {
      const op = operation();
      uow.hooks.set(1, (working) => {
        storeCommitted(
          working,
          op,
          'earlier',
          `${op.providerId}:${op.externalTransactionId}`,
        );
      });
      const result = await submit.execute(sqs(op));
      expect(result.transaction.id).toBe('earlier');
      const rows = [...inner.store.inbox.values()];
      expect(rows.map((r) => r.transactionId)).toEqual(['earlier']);
    });

    it('treats a delivery committed concurrently with the decision as a duplicate, before any lock', async () => {
      const op = operation();
      const message = sqs(op);
      const messageId = message.inbox?.messageId ?? '';
      // Another consumer commits the same delivery right after our unlocked lookup.
      uow.hooks.set(1, (working) => {
        storeCommitted(working, op, 'other-consumer', message.idempotencyKey);
        working.inbox.set(`wager-transactions-consumer:${messageId}`, {
          consumerName: 'wager-transactions-consumer',
          messageId,
          payloadHash: payloadHash(op),
          idempotencyKey: message.idempotencyKey,
          transactionId: 'other-consumer',
          receivedAt: inner.clock.now(),
          processedAt: inner.clock.now(),
        });
      });
      const result = await submit.execute(message);
      expect(result).toMatchObject({
        replay: true,
        duplicate: true,
        transaction: { id: 'other-consumer' },
      });
      expect(uow.locks).toEqual([]);
    });
  });

  it('puts the provider, wallet, and transaction in the request context', async () => {
    const result = await submit.execute(command(operation()));
    expect(context.fields).toEqual({
      providerId: 'provider-a',
      walletId: WALLET,
      transactionId: result.transaction.id,
    });
  });
});
