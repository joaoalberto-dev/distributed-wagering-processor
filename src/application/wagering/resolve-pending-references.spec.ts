import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeRequestContext } from '../../../test/support/fakes/fake-request-context.js';
import { InMemoryUnitOfWork } from '../../../test/support/fakes/in-memory-unit-of-work.js';
import { RecordingLogger } from '../../../test/support/fakes/recording-logger.js';
import { RecordingTelemetry } from '../../../test/support/fakes/recording-telemetry.js';
import { SequentialIds } from '../../../test/support/fakes/sequential-ids.js';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { ContentionError, OutageError } from '../errors.js';
import type {
  TxContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../ports/unit-of-work.js';
import {
  REFERENCE_WORKER_DEFAULTS,
  ResolvePendingReferences,
} from './resolve-pending-references.js';
import {
  SubmitWagerTransaction,
  type WagerOperation,
} from './submit-wager-transaction.js';

const WALLET = 'aaaaaaaa-0000-7000-8000-000000000000';
const PLAYER = 'bbbbbbbb-0000-7000-8000-000000000000';
const TTL_MS = 60_000;
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

/**
 * The fake unit of work, with the wallet locks recorded, wallets that a
 * `SKIP LOCKED` lock finds busy, a hook on the lock, and a reference read
 * that throws.
 */
class WorkerUnitOfWork implements UnitOfWork {
  readonly locks: { id: string; mode: string }[] = [];
  readonly busy = new Set<string>();
  /** Rows another worker holds: a `SKIP LOCKED` claim finds them taken. */
  readonly held = new Set<string>();
  /** Runs inside the locking transaction, as another worker's committed work. */
  onLock: ((tx: TxContext) => Promise<void>) | undefined;
  /** Thrown by every reference read while set. */
  referenceReadError: Error | undefined;

  constructor(readonly inner: InMemoryUnitOfWork) {}

  run<T>(
    fn: (tx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    return this.inner.run((tx) => fn(this.wrap(tx)), options);
  }

  private wrap(tx: TxContext): TxContext {
    const { wallets, transactions } = tx;
    return {
      ...tx,
      wallets: {
        lock: async (id, mode) => {
          this.locks.push({ id, mode });
          const hook = this.onLock;
          this.onLock = undefined;
          await hook?.(tx);
          if (mode === 'skip-locked' && this.busy.has(id)) return null;
          return wallets.lock(id, mode);
        },
        findById: (id) => wallets.findById(id),
        findByPlayerAndCurrency: (p, c) =>
          wallets.findByPlayerAndCurrency(p, c),
        insert: (w) => wallets.insert(w),
        save: (w) => wallets.save(w),
      },
      transactions: new Proxy(transactions, {
        get: (target, property, receiver) => {
          const value: unknown = Reflect.get(target, property, receiver);
          const error = this.referenceReadError;
          if (property === 'claim') {
            return (id: string, mode: 'wait' | 'skip-locked') =>
              mode === 'skip-locked' && this.held.has(id)
                ? Promise.resolve(false)
                : target.claim(id, mode);
          }
          if (property === 'findByExternalId' && error !== undefined) {
            return () => Promise.reject(error);
          }
          return typeof value === 'function'
            ? ((value as (...args: unknown[]) => unknown).bind(
                target,
              ) as unknown)
            : value;
        },
      }),
    };
  }
}

let inner: InMemoryUnitOfWork;
let uow: WorkerUnitOfWork;
let telemetry: RecordingTelemetry;
let logger: RecordingLogger;
let submit: SubmitWagerTransaction;
let worker: ResolvePendingReferences;

beforeEach(() => {
  inner = new InMemoryUnitOfWork();
  uow = new WorkerUnitOfWork(inner);
  telemetry = new RecordingTelemetry();
  logger = new RecordingLogger();
  const ids = new SequentialIds();
  const context = new FakeRequestContext();
  submit = new SubmitWagerTransaction(
    inner,
    inner.clock,
    ids,
    new RecordingTelemetry(),
    new RecordingLogger(),
    { authorize: () => Promise.resolve() },
    context,
    { referenceTtlMs: TTL_MS },
  );
  // The upper end of the jitter, so every delay is the full backoff.
  worker = new ResolvePendingReferences(
    uow,
    inner.clock,
    ids,
    telemetry,
    logger,
    context,
    { ...REFERENCE_WORKER_DEFAULTS, referenceTtlMs: TTL_MS },
    () => 1,
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

async function send(op: WagerOperation) {
  const key = `${op.providerId}:${op.externalTransactionId}`;
  const result = await submit.execute({
    operation: op,
    idempotencyKey: key,
    channel: 'http',
    correlationId: `correlation-${op.externalTransactionId}`,
    causationId: key,
  });
  return result.transaction;
}

/** A `REFUND` of a `BET` that has not arrived: stored as `PENDING_REFERENCE`. */
async function pendingRefund(betExternalId = 'bet-later') {
  const refund = await send(
    operation({
      kind: 'REFUND',
      referenceExternalTransactionId: betExternalId,
    }),
  );
  expect(refund.status).toBe('PENDING_REFERENCE');
  return refund.id;
}

const row = (id: string) => {
  const state = inner.store.transactions.get(id);
  if (state === undefined) throw new Error(`no transaction ${id}`);
  return state;
};
const times = (id: string) => {
  const pending = inner.store.pending.get(id);
  if (pending === undefined) throw new Error(`no schedule for ${id}`);
  return pending;
};
/** Milliseconds from now until the row's next attempt. */
const dueIn = (id: string) =>
  times(id).nextAttemptAt.getTime() - inner.clock.now().getTime();
/** Moves the clock to the row's next attempt. */
const reachNextAttempt = (id: string) => inner.clock.advance(dueIn(id));
const balance = () => inner.store.wallets.get(WALLET)?.balance.toProps().amount;
const eventTypes = () =>
  [...inner.store.outbox.values()].map((m) => m.eventType);
const attempts = () => telemetry.of('referenceAttempt').map(([o]) => o);

describe('a reference that is still absent', () => {
  it('reschedules each attempt with a growing delay and counts it', async () => {
    const id = await pendingRefund();

    for (const expected of [1000, 2000, 4000, 8000]) {
      reachNextAttempt(id);
      expect(await worker.runCycle()).toBe(1);
      expect(dueIn(id)).toBe(expected);
    }
    expect(row(id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 4 });
    expect(attempts()).toEqual(['wait', 'wait', 'wait', 'wait']);
    expect(uow.locks.every((lock) => lock.mode === 'skip-locked')).toBe(true);
  });

  it('never schedules past the TTL', async () => {
    const id = await pendingRefund();
    inner.clock.advance(TTL_MS - 500);

    await worker.runCycle();

    expect(times(id).nextAttemptAt).toEqual(times(id).expiresAt);
  });

  it('selects nothing before the row is due', async () => {
    await pendingRefund();

    expect(await worker.runCycle()).toBe(0);
    expect(uow.locks).toEqual([]);
  });
});

describe('a reference that arrives', () => {
  it('processes the dependent after the wake-up and records the reference', async () => {
    const id = await pendingRefund('bet-1');
    const bet = await send(operation({ externalTransactionId: 'bet-1' }));
    expect(balance()).toBe('75.00');
    expect(dueIn(id)).toBe(0);

    expect(await worker.runCycle()).toBe(1);

    expect(row(id)).toMatchObject({
      status: 'PROCESSED',
      referenceTransactionId: bet.id,
      attempts: 0,
    });
    expect(balance()).toBe('100.00');
    expect(attempts()).toEqual(['processed']);
    expect(telemetry.of('transactionDecided')).toEqual([
      ['REFUND', 'PROCESSED', 'worker'],
    ]);
    expect(eventTypes()).toContain('WagerTransactionProcessed');
  });

  it('rejects the dependent by the same rules as submission', async () => {
    const id = await pendingRefund('bet-1');
    await send(
      operation({
        externalTransactionId: 'bet-1',
        money: brl('30.00').toProps(),
      }),
    );

    await worker.runCycle();

    expect(row(id)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_MISMATCH',
      resultDetails: { field: 'amount' },
    });
    expect(attempts()).toEqual(['rejected']);
  });

  it('flags a WIN settled against a reversed BET', async () => {
    const win = await send(
      operation({
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-1',
      }),
    );
    await send(operation({ externalTransactionId: 'bet-1' }));
    const refund = await send(
      operation({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(refund.status).toBe('PROCESSED');

    await worker.runCycle();

    expect(row(win.id)).toMatchObject({
      status: 'PROCESSED',
      resultDetails: { referenceReversedBy: refund.id },
    });
    expect(logger.warnings.map((w) => w.message)).toEqual([
      'settled against a reversed reference',
    ]);
    expect(telemetry.of('settlementOnReversedReference')).toEqual([[]]);
  });
});

describe('a busy wallet', () => {
  it('pushes the row back by 1 s without counting an attempt', async () => {
    const id = await pendingRefund();
    reachNextAttempt(id);
    uow.busy.add(WALLET);

    await worker.runCycle();

    expect(row(id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0 });
    expect(dueIn(id)).toBe(1000);
    expect(attempts()).toEqual(['skipped']);
  });

  it('does not stop the other due rows of the cycle', async () => {
    const OTHER = 'aaaaaaaa-0000-7000-8000-000000000001';
    const OTHER_PLAYER = 'bbbbbbbb-0000-7000-8000-000000000001';
    inner.store.wallets.set(
      OTHER,
      Wallet.open({
        id: OTHER,
        playerId: OTHER_PLAYER,
        initialBalance: brl('0.00'),
        at: inner.clock.now(),
      }).toState(),
    );
    const blocked = await pendingRefund();
    const free = await send(
      operation({
        kind: 'REFUND',
        walletId: OTHER,
        playerId: OTHER_PLAYER,
        referenceExternalTransactionId: 'bet-other',
      }),
    );
    // A first wait is at most the 1 s base.
    inner.clock.advance(1000);
    uow.busy.add(WALLET);

    expect(await worker.runCycle()).toBe(2);

    expect(row(blocked).attempts).toBe(0);
    expect(row(free.id).attempts).toBe(1);
  });
});

describe('another worker', () => {
  it('leaves a row it holds alone: no lock on the wallet, no push-back, no attempt', async () => {
    const id = await pendingRefund();
    reachNextAttempt(id);
    uow.held.add(id);

    await worker.runCycle();

    expect(uow.locks).toEqual([]);
    expect(dueIn(id)).toBe(0);
    expect(row(id).attempts).toBe(0);
    expect(attempts()).toEqual(['skipped']);
  });

  it('skips a row whose backoff window was already handled', async () => {
    const id = await pendingRefund();
    reachNextAttempt(id);
    uow.onLock = async (tx) => {
      expect(await tx.transactions.reschedule(id, 5000)).toBe(true);
    };

    await worker.runCycle();

    expect(row(id).attempts).toBe(1);
    expect(attempts()).toEqual(['skipped']);
  });
});

describe('at the TTL', () => {
  it('rejects an absent reference as REFERENCE_NOT_FOUND, with a blocking lock', async () => {
    const id = await pendingRefund();
    inner.clock.advance(TTL_MS);

    await worker.runCycle();

    expect(row(id)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
    });
    expect(uow.locks).toEqual([{ id: WALLET, mode: 'wait' }]);
    expect(eventTypes()).toContain('WagerTransactionRejected');
  });

  it('rejects a reference still pending as REFERENCE_NOT_READY', async () => {
    const refund = await pendingRefund('bet-1');
    const rollback = await send(
      operation({
        kind: 'ROLLBACK',
        referenceExternalTransactionId: row(refund).externalTransactionId ?? '',
      }),
    );
    expect(rollback.status).toBe('PENDING_REFERENCE');
    // Only the ROLLBACK has reached its TTL.
    inner.clock.advance(1000);
    inner.store.pending.set(rollback.id, {
      nextAttemptAt: inner.clock.now(),
      expiresAt: inner.clock.now(),
    });
    times(refund).nextAttemptAt = new Date(inner.clock.now().getTime() + 5000);

    await worker.runCycle();

    expect(row(rollback.id)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_READY',
    });
    expect(row(refund).status).toBe('PENDING_REFERENCE');
  });
});

describe('errors', () => {
  it('reschedules an unexpected error before the TTL', async () => {
    const id = await pendingRefund();
    reachNextAttempt(id);
    uow.referenceReadError = new TypeError('boom');

    await worker.runCycle();

    expect(row(id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
    expect(dueIn(id)).toBe(1000);
    expect(attempts()).toEqual(['wait']);
    expect(logger.warnings[0]).toMatchObject({
      message: 'pending reference attempt failed; rescheduled',
      fields: { transactionId: id, reason: 'TypeError' },
    });
  });

  it('writes FAILED through the persistence step when the final attempt throws', async () => {
    const id = await pendingRefund();
    inner.clock.advance(TTL_MS);
    uow.referenceReadError = new TypeError('boom');

    await worker.runCycle();

    expect(row(id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
    });
    expect(eventTypes()).toContain('WagerTransactionFailed');
    expect(balance()).toBe('100.00');
    expect(attempts()).toEqual(['failed']);
    expect(telemetry.of('referenceFailed')).toHaveLength(1);
    expect(telemetry.of('transactionDecided')).toEqual([
      ['REFUND', 'FAILED', 'worker'],
    ]);
  });

  it('skips a row on contention; it stays due and uncounted', async () => {
    const id = await pendingRefund();
    reachNextAttempt(id);
    uow.referenceReadError = new ContentionError('lock timeout');

    await worker.runCycle();

    expect(row(id).attempts).toBe(0);
    expect(dueIn(id)).toBe(0);
    expect(attempts()).toEqual(['skipped']);
  });

  it('ends the cycle on an outage', async () => {
    const id = await pendingRefund();
    reachNextAttempt(id);
    uow.referenceReadError = new OutageError('postgres', 'connection refused');

    const error = await rejectionOf(worker.runCycle());

    expect(error).toBeInstanceOf(OutageError);
    expect(row(id).attempts).toBe(0);
    expect(attempts()).toEqual([]);
  });
});
