import { beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryUnitOfWork } from '../../../test/support/fakes/in-memory-unit-of-work.js';
import { SequentialIds } from '../../../test/support/fakes/sequential-ids.js';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import { Money } from '../../domain/money/money.js';
import { InvariantViolationError } from '../../domain/shared/domain-error.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../domain/transaction/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  applyOutcome,
  type Outcome,
  type OutcomeContext,
} from './apply-outcome.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const WALLET = 'aaaaaaaa-0000-7000-8000-000000000000';
const PLAYER = 'bbbbbbbb-0000-7000-8000-000000000000';

let uow: InMemoryUnitOfWork;
let ctx: OutcomeContext;

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  ctx = {
    ids: new SequentialIds(),
    correlationId: 'correlation-1',
    causationId: 'provider-a:ext-1',
    occurredAt: uow.clock.now(),
    referenceTtlMs: 86_400_000,
  };
  const wallet = Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: brl('100.00'),
    at: uow.clock.now(),
  });
  uow.store.wallets.set(WALLET, wallet.toState());
});

function operation(overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.create({
    id: 'cccccccc-0000-7000-8000-000000000000',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'v1:abc',
    walletId: WALLET,
    playerId: PLAYER,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    correlationId: 'correlation-1',
    at: uow.clock.now(),
    ...overrides,
  });
}

function apply(transaction: WagerTransaction, outcome: Outcome) {
  return uow.run(
    async (tx) => {
      const wallet = await tx.wallets.lock(transaction.walletId, 'wait');
      if (wallet === null) throw new Error('wallet missing');
      return applyOutcome(tx, transaction, wallet, outcome, ctx);
    },
    { retryContention: false },
  );
}

const eventTypes = () => [...uow.store.outbox.values()].map((m) => m.eventType);

describe('applyOutcome', () => {
  it('processes a debit: transaction, wallet, entry, and two events', async () => {
    const { entry } = await apply(operation(), {
      kind: 'process',
      effect: { direction: LedgerDirection.Debit, amount: brl('25.00') },
    });
    const wallet = uow.store.wallets.get(WALLET);
    expect(wallet?.version).toBe(2);
    expect(wallet?.balance.equals(brl('75.00'))).toBe(true);
    expect(entry?.walletVersion).toBe(2);
    expect(uow.store.ledger.size).toBe(1);
    const stored = [...uow.store.transactions.values()][0];
    expect(stored?.status).toBe('PROCESSED');
    expect(stored?.resultBalance?.equals(brl('75.00'))).toBe(true);
    expect(eventTypes()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('processes without an effect: no wallet change, no entry, one event', async () => {
    await apply(operation({ kind: 'LOSS', money: brl('0.00') }), {
      kind: 'process',
      effect: null,
    });
    expect(uow.store.wallets.get(WALLET)?.version).toBe(1);
    expect(uow.store.ledger.size).toBe(0);
    expect(eventTypes()).toEqual(['WagerTransactionProcessed']);
  });

  it('records the resolved reference on a processed result', async () => {
    const reference = 'dddddddd-0000-7000-8000-000000000000';
    ctx = { ...ctx, referenceTransactionId: reference };
    await apply(
      operation({ kind: 'WIN', referenceExternalTransactionId: 'ext-0' }),
      {
        kind: 'process',
        effect: { direction: LedgerDirection.Credit, amount: brl('25.00') },
      },
    );
    const stored = [...uow.store.transactions.values()][0];
    expect(stored?.referenceTransactionId).toBe(reference);
  });

  it('rejects with the balance snapshot and the details', async () => {
    await apply(operation(), {
      kind: 'reject',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    const stored = [...uow.store.transactions.values()][0];
    expect(stored).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(stored?.resultBalance?.equals(brl('100.00'))).toBe(true);
    expect(uow.store.ledger.size).toBe(0);
    expect(eventTypes()).toEqual(['WagerTransactionRejected']);
  });

  it('stores a waiting transaction with its schedule and expiry', async () => {
    const refund = operation({
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-0',
    });
    await apply(refund, { kind: 'wait' });
    expect(uow.store.transactions.get(refund.id)?.status).toBe(
      'PENDING_REFERENCE',
    );
    const expiry = uow.store.pending.get(refund.id)?.expiresAt;
    expect(expiry?.getTime()).toBe(uow.clock.now().getTime() + 86_400_000);
    const [event] = [...uow.store.outbox.values()];
    expect(event?.eventType).toBe('WagerTransactionPendingReference');
    expect(event?.payload).toMatchObject({
      data: { referenceExpiresAt: expiry?.toISOString() },
    });
  });

  it('wakes the pending dependents when a BET becomes terminal', async () => {
    const refund = operation({
      id: 'dddddddd-0000-7000-8000-000000000000',
      externalTransactionId: 'ext-2',
      idempotencyKey: 'provider-a:ext-2',
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-1',
    });
    await apply(refund, { kind: 'wait' });
    uow.clock.advance(100);
    expect(
      await uow.run((tx) => tx.transactions.selectDue(10, 10), {
        retryContention: false,
      }),
    ).toEqual([]);

    await apply(operation(), {
      kind: 'process',
      effect: { direction: LedgerDirection.Debit, amount: brl('25.00') },
    });
    expect(
      await uow.run((tx) => tx.transactions.selectDue(10, 10), {
        retryContention: false,
      }),
    ).toEqual([refund.id]);
  });

  it('marks a pending transaction FAILED and saves it', async () => {
    const refund = operation({
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-0',
    });
    await apply(refund, { kind: 'wait' });
    const loaded = WagerTransaction.rehydrate(
      uow.store.transactions.get(refund.id) ?? refund.toState(),
    );
    await apply(loaded, { kind: 'fail' });
    expect(uow.store.transactions.get(refund.id)).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
    });
    expect(eventTypes()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionFailed',
    ]);
  });

  it('refuses to apply a wait to a transaction the worker loaded', async () => {
    const refund = operation({
      kind: 'REFUND',
      referenceExternalTransactionId: 'ext-0',
    });
    await apply(refund, { kind: 'wait' });
    const loaded = WagerTransaction.rehydrate(
      uow.store.transactions.get(refund.id) ?? refund.toState(),
    );
    expect(await rejectionOf(apply(loaded, { kind: 'wait' }))).toBeInstanceOf(
      InvariantViolationError,
    );
  });

  it('refuses an OPENING that does not match the new wallet', async () => {
    const opening = WagerTransaction.open({
      id: 'eeeeeeee-0000-7000-8000-000000000000',
      walletId: WALLET,
      playerId: PLAYER,
      money: brl('50.00'),
      correlationId: 'correlation-1',
      at: uow.clock.now(),
    });
    expect(
      await rejectionOf(
        apply(opening, {
          kind: 'process',
          effect: { direction: LedgerDirection.Credit, amount: brl('50.00') },
        }),
      ),
    ).toBeInstanceOf(InvariantViolationError);
    expect(uow.store.transactions.size).toBe(0);
  });
});
