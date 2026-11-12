import { beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryUnitOfWork } from '../../../test/support/fakes/in-memory-unit-of-work.js';
import { SequentialIds } from '../../../test/support/fakes/sequential-ids.js';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WalletAlreadyExists } from '../errors.js';
import { OpenWallet } from './open-wallet.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let uow: InMemoryUnitOfWork;
let openWallet: OpenWallet;

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  openWallet = new OpenWallet(uow, uow.clock, new SequentialIds());
});

const open = (amount: string, currency = 'BRL') =>
  openWallet.execute({
    playerId: PLAYER,
    initialBalance: Money.from({ amount, currency }),
    correlationId: 'correlation-1',
  });

describe('OpenWallet', () => {
  it('opens at zero with the wallet alone: no transaction, entry, or event', async () => {
    const view = await open('0.00');
    expect(view).toEqual({
      id: view.id,
      playerId: PLAYER,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(uow.store.wallets.size).toBe(1);
    expect(uow.store.transactions.size).toBe(0);
    expect(uow.store.ledger.size).toBe(0);
    expect(uow.store.outbox.size).toBe(0);
    expect(uow.runs).toEqual([{ retryContention: true }]);
  });

  it('records a positive opening as an OPENING credit at version 1 in the same unit of work', async () => {
    const view = await open('100.00');
    expect(view.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(view.version).toBe(1);

    const [opening] = [...uow.store.transactions.values()];
    expect(opening).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      walletId: view.id,
      providerId: null,
      correlationId: 'correlation-1',
    });
    expect(opening?.resultBalance?.equals(brl('100.00'))).toBe(true);

    const [entry] = [...uow.store.ledger.values()];
    expect(entry?.direction).toBe('CREDIT');
    expect(entry?.walletVersion).toBe(1);
    expect(entry?.balanceBefore.equals(brl('0.00'))).toBe(true);
    expect(entry?.balanceAfter.equals(brl('100.00'))).toBe(true);

    const events = [...uow.store.outbox.values()];
    expect(events.map((e) => e.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events[0]?.payload).toMatchObject({
      correlationId: 'correlation-1',
      causationId: view.id,
    });
    expect(uow.runs).toHaveLength(1);
  });

  it('refuses a second wallet for the same player and currency, naming the first', async () => {
    const first = await open('10.00');
    const error = await rejectionOf(open('0.00'));
    expect(error).toBeInstanceOf(WalletAlreadyExists);
    expect((error as WalletAlreadyExists).walletId).toBe(first.id);
    expect(uow.store.wallets.size).toBe(1);
  });

  it('allows the same player in another currency', async () => {
    await open('10.00', 'BRL');
    const usd = await open('5.00', 'USD');
    expect(usd.balance).toEqual({ amount: '5.00', currency: 'USD' });
    expect(uow.store.wallets.size).toBe(2);
  });

  it('fills in the winner of a race lost at commit', async () => {
    let winner: string | undefined;
    uow.beforeCommit = (store) => {
      const other = Wallet.open({
        id: 'ffffffff-0000-7000-8000-000000000000',
        playerId: PLAYER,
        initialBalance: brl('0.00'),
        at: new Date(),
      });
      winner = other.id;
      store.wallets.set(other.id, other.toState());
      // The concurrent open committed first.
      uow.store.wallets.set(other.id, other.toState());
    };
    const error = await rejectionOf(open('50.00'));
    expect(error).toBeInstanceOf(WalletAlreadyExists);
    expect((error as WalletAlreadyExists).walletId).toBe(winner);
    expect(uow.store.ledger.size).toBe(0);
  });
});
