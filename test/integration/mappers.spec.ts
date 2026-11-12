/**
 * Each aggregate equals itself after a save and a load through the unit of
 * work: the records and mappers lose nothing on the way to the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TxContext } from '../../src/application/ports/unit-of-work.js';
import type { Application } from '../../src/bootstrap/container.js';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-events.js';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry.js';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { Money } from '../../src/domain/money/money.js';
import { WagerTransaction } from '../../src/domain/transaction/wager-transaction.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { newId } from '../support/database.js';
import { startInProcess } from '../support/in-process.js';
import { useInfrastructure } from '../support/infrastructure.js';

const infrastructure = useInfrastructure('mappers');

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-12T10:00:00.123Z');
const later = new Date('2026-11-12T10:00:05.456Z');

let app: Application;

beforeAll(async () => {
  app = await startInProcess(infrastructure);
});

afterAll(async () => {
  await app.close();
});

function write(fn: (tx: TxContext) => Promise<unknown>): Promise<unknown> {
  return app.unitOfWork.run(fn, { retryContention: false });
}

function read<T>(fn: (tx: TxContext) => Promise<T>): Promise<T> {
  return app.unitOfWork.run(fn, { retryContention: false });
}

/** A wallet opened with 100.00: the wallet, its OPENING credit, and entry 1. */
async function openedWallet(): Promise<{
  wallet: Wallet;
  opening: WagerTransaction;
  entry: WalletLedgerEntry;
}> {
  const wallet = Wallet.open({
    id: newId(),
    playerId: newId(),
    initialBalance: brl('100.00'),
    at,
  });
  const opening = WagerTransaction.open({
    id: newId(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: brl('100.00'),
    correlationId: newId(),
    at,
  });
  opening.markProcessed({ balance: brl('100.00'), at });
  const entry = WalletLedgerEntry.create({
    id: newId(),
    walletId: wallet.id,
    transactionId: opening.id,
    direction: LedgerDirection.Credit,
    amount: brl('100.00'),
    balanceBefore: brl('0.00'),
    balanceAfter: brl('100.00'),
    walletVersion: 1,
    createdAt: at,
  });
  await write(async (tx) => {
    await tx.wallets.insert(wallet);
    await tx.transactions.insert(opening);
    await tx.ledger.append(entry);
  });
  return { wallet, opening, entry };
}

function bet(
  wallet: Wallet,
  overrides: Partial<{
    kind: 'BET' | 'LOSS' | 'REFUND';
    reference: string;
    amount: string;
  }> = {},
): WagerTransaction {
  const external = `ext-${newId()}`;
  return WagerTransaction.create({
    id: newId(),
    providerId: 'provider-mappers',
    externalTransactionId: external,
    idempotencyKey: `key-${external}`,
    payloadHash: `v1:${newId()}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: overrides.kind ?? 'BET',
    money: brl(overrides.amount ?? '25.00'),
    ...(overrides.reference === undefined
      ? {}
      : { referenceExternalTransactionId: overrides.reference }),
    correlationId: newId(),
    at,
  });
}

describe('mappers', () => {
  it('round-trips a wallet, its OPENING transaction, and its ledger entry', async () => {
    const { wallet, opening, entry } = await openedWallet();

    const loaded = await read(async (tx) => ({
      wallet: await tx.wallets.findById(wallet.id),
      byPlayer: await tx.wallets.findByPlayerAndCurrency(
        wallet.playerId,
        'BRL',
      ),
      opening: await tx.transactions.findById(opening.id),
      entry: await tx.ledger.findByTransactionId(opening.id),
    }));

    expect(loaded.wallet?.toState()).toEqual(wallet.toState());
    expect(loaded.byPlayer?.toState()).toEqual(wallet.toState());
    expect(loaded.opening?.toState()).toEqual(opening.toState());
    expect(loaded.entry?.toState()).toEqual(entry.toState());
  });

  it('round-trips a debit: the wallet change, the transaction result, and the entry', async () => {
    const { wallet } = await openedWallet();
    const transaction = bet(wallet);
    let entry: WalletLedgerEntry | undefined;

    await write(async (tx) => {
      const locked = await tx.wallets.lock(wallet.id, 'wait');
      if (locked === null) throw new Error('wallet not found');
      const applied = locked.apply(
        { direction: LedgerDirection.Debit, amount: transaction.money },
        later,
      );
      transaction.markProcessed({ balance: applied.balanceAfter, at: later });
      entry = WalletLedgerEntry.create({
        id: newId(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: LedgerDirection.Debit,
        amount: transaction.money,
        balanceBefore: applied.balanceBefore,
        balanceAfter: applied.balanceAfter,
        walletVersion: applied.version,
        createdAt: later,
      });
      await tx.transactions.insert(transaction);
      await tx.ledger.append(entry);
      await tx.wallets.save(locked);
      wallet.apply(
        { direction: LedgerDirection.Debit, amount: transaction.money },
        later,
      );
    });

    const loaded = await read(async (tx) => ({
      wallet: await tx.wallets.findById(wallet.id),
      byKey: await tx.transactions.findByKey(
        'provider-mappers',
        transaction.idempotencyKey ?? '',
      ),
      byExternalId: await tx.transactions.findByExternalId(
        'provider-mappers',
        transaction.externalTransactionId ?? '',
      ),
      entry: await tx.ledger.findByTransactionId(transaction.id),
    }));
    expect(loaded.wallet?.toState()).toEqual(wallet.toState());
    expect(loaded.wallet?.balance.toProps()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
    expect(loaded.byKey?.toState()).toEqual(transaction.toState());
    expect(loaded.byExternalId?.toState()).toEqual(transaction.toState());
    expect(loaded.entry?.toState()).toEqual(entry?.toState());
  });

  it('round-trips a PENDING_REFERENCE transaction and its decision, with result details', async () => {
    const { wallet } = await openedWallet();
    const transaction = bet(wallet, {
      kind: 'REFUND',
      reference: `missing-${newId()}`,
    });
    const backoffMs = transaction.waitForReference(() => 1);

    const before = Date.now();
    const inserted = (await write((tx) =>
      tx.transactions.insert(transaction, { backoffMs, ttlMs: 60_000 }),
    )) as { referenceExpiresAt?: Date };
    const expiresAt = inserted.referenceExpiresAt?.getTime() ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);

    const pending = await read((tx) =>
      tx.transactions.findById(transaction.id),
    );
    expect(pending?.toState()).toEqual(transaction.toState());

    transaction.markRejected({
      failureCode: 'REFERENCE_MISMATCH',
      balance: brl('100.00'),
      details: { field: 'roundId' },
      at: later,
    });
    await write(async (tx) => {
      const loaded = await tx.transactions.findById(transaction.id);
      if (loaded === null) throw new Error('transaction not found');
      loaded.markRejected({
        failureCode: 'REFERENCE_MISMATCH',
        balance: brl('100.00'),
        details: { field: 'roundId' },
        at: later,
      });
      await tx.transactions.save(loaded);
    });

    const decided = await read((tx) =>
      tx.transactions.findById(transaction.id),
    );
    expect(decided?.toState()).toEqual(transaction.toState());
  });

  it('round-trips a zero LOSS, and finds a successful reversal', async () => {
    const { wallet } = await openedWallet();
    const loss = bet(wallet, { kind: 'LOSS', amount: '0.00' });
    loss.markProcessed({ balance: brl('100.00'), at: later });
    await write((tx) => tx.transactions.insert(loss));

    const loaded = await read((tx) => tx.transactions.findById(loss.id));
    expect(loaded?.toState()).toEqual(loss.toState());
    expect(
      await read((tx) => tx.transactions.findSuccessfulReversal(loss.id)),
    ).toBeNull();
  });

  it('round-trips an inbox message, and reports a second insert of the same key', async () => {
    const { opening } = await openedWallet();
    const message = InboxMessage.receive({
      consumerName: 'mappers-consumer',
      messageId: newId(),
      payloadHash: 'v1:abc',
      idempotencyKey: `key-${newId()}`,
      transactionId: opening.id,
      at,
    });

    expect(await read((tx) => tx.inbox.insertIfAbsent(message))).toBe(true);
    expect(await read((tx) => tx.inbox.insertIfAbsent(message))).toBe(false);
    const loaded = await read((tx) =>
      tx.inbox.find('mappers-consumer', message.messageId),
    );
    expect(loaded?.toState()).toEqual(message.toState());
  });

  it('round-trips an outbox message through claim, retry, and publication', async () => {
    const { opening } = await openedWallet();
    const event = WagerTransactionProcessed.from(opening, {
      eventId: newId(),
      correlationId: opening.correlationId,
      causationId: opening.walletId,
      occurredAt: at,
    });
    const message = OutboxMessage.enqueue(event);
    await write((tx) => tx.outbox.enqueue([message]));

    const claimed = await read(async (tx) =>
      (await tx.outbox.claimDue(1000)).find((m) => m.id === message.id),
    );
    expect(claimed?.toState()).toEqual(message.toState());

    await write((tx) => tx.outbox.scheduleRetry(message.id, 0, 'throttled'));
    const retried = await read(async (tx) =>
      (await tx.outbox.claimDue(1000)).find((m) => m.id === message.id),
    );
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe('throttled');

    await write((tx) => tx.outbox.markPublished([message.id]));
    const after = await read(async (tx) =>
      (await tx.outbox.claimDue(1000)).find((m) => m.id === message.id),
    );
    expect(after).toBeUndefined();
  });
});
