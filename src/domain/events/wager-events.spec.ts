import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { Money } from '../money/money.js';
import { InvariantViolationError } from '../shared/domain-error.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../transaction/wager-transaction.js';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './wager-events.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-12T10:00:00.000Z');
const ctx = {
  eventId: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'provider-a:external-1',
  occurredAt: at,
};
const ENVELOPE_KEYS = [
  'eventId',
  'eventType',
  'aggregateId',
  'correlationId',
  'causationId',
  'occurredAt',
  'version',
  'data',
];

function bet(overrides: Partial<CreateWagerTransactionProps> = {}) {
  return WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'v1:abc',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('25.00'),
    correlationId: 'correlation-1',
    at,
    ...overrides,
  });
}

/** Through JSON, as the outbox stores it. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('WagerTransactionProcessed', () => {
  it('serializes the envelope and the data with money as strings', () => {
    const transaction = bet();
    transaction.markProcessed({ balance: brl('75.00'), at });
    const event = WagerTransactionProcessed.from(transaction, ctx);

    expect(Object.keys(event.toJSON())).toEqual(ENVELOPE_KEYS);
    expect(wire(event)).toEqual({
      eventId: 'event-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'transaction-1',
      correlationId: 'correlation-1',
      causationId: 'provider-a:external-1',
      occurredAt: '2026-11-12T10:00:00.000Z',
      version: 1,
      data: {
        transactionId: 'transaction-1',
        providerId: 'provider-a',
        externalTransactionId: 'external-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        balance: { amount: '75.00', currency: 'BRL' },
      },
    });
  });

  it('carries the details, such as referenceReversedBy', () => {
    const win = bet({
      kind: 'WIN',
      referenceExternalTransactionId: 'external-0',
    });
    win.markProcessed({
      balance: brl('125.00'),
      details: { referenceReversedBy: 'transaction-r' },
      at,
    });
    expect(WagerTransactionProcessed.from(win, ctx).data.details).toEqual({
      referenceReversedBy: 'transaction-r',
    });
  });

  it('omits the provider fields for OPENING', () => {
    const opening = WagerTransaction.open({
      id: 'transaction-0',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('100.00'),
      correlationId: 'correlation-1',
      at,
    });
    opening.markProcessed({ balance: brl('100.00'), at });
    const data = wire(WagerTransactionProcessed.from(opening, ctx).data);
    expect(data).toEqual({
      transactionId: 'transaction-0',
      walletId: 'wallet-1',
      playerId: 'player-1',
      kind: 'OPENING',
      money: { amount: '100.00', currency: 'BRL' },
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  it('refuses a transaction that is not PROCESSED', () => {
    expect(() => WagerTransactionProcessed.from(bet(), ctx)).toThrow(
      InvariantViolationError,
    );
  });

  it('freezes its data and omits an absent causationId', () => {
    const transaction = bet();
    transaction.markProcessed({ balance: brl('75.00'), at });
    const event = WagerTransactionProcessed.from(transaction, {
      eventId: 'event-2',
      correlationId: 'correlation-1',
      occurredAt: at,
    });
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect('causationId' in event.toJSON()).toBe(false);
  });
});

describe('WalletBalanceChanged', () => {
  it('serializes the challenge fields of the ledger entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      amount: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
      walletVersion: 2,
      createdAt: at,
    });
    const event = WalletBalanceChanged.from(entry, ctx);
    expect(Object.keys(event.toJSON())).toEqual(ENVELOPE_KEYS);
    expect(wire(event)).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });
});

describe('WagerTransactionRejected', () => {
  it('carries the failure code, the balance snapshot, and the details', () => {
    const refund = bet({
      kind: 'REFUND',
      referenceExternalTransactionId: 'external-0',
    });
    refund.markRejected({
      failureCode: 'REFERENCE_MISMATCH',
      balance: brl('10.00'),
      details: { field: 'amount' },
      at,
    });
    const event = WagerTransactionRejected.from(refund, ctx);
    expect(Object.keys(event.toJSON())).toEqual(ENVELOPE_KEYS);
    expect(wire(event.toJSON().data)).toEqual({
      transactionId: 'transaction-1',
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      failureCode: 'REFERENCE_MISMATCH',
      balance: { amount: '10.00', currency: 'BRL' },
      details: { field: 'amount' },
    });
    expect(event.eventType).toBe('WagerTransactionRejected');
  });

  it('refuses a transaction that is not REJECTED', () => {
    expect(() => WagerTransactionRejected.from(bet(), ctx)).toThrow(
      InvariantViolationError,
    );
  });
});

describe('WagerTransactionPendingReference', () => {
  it('carries the reference and its expiry as ISO-8601', () => {
    const refund = bet({
      kind: 'REFUND',
      referenceExternalTransactionId: 'external-0',
    });
    refund.waitForReference();
    const event = WagerTransactionPendingReference.from(
      refund,
      new Date('2026-11-13T10:00:00.000Z'),
      ctx,
    );
    expect(Object.keys(event.toJSON())).toEqual(ENVELOPE_KEYS);
    expect(wire(event.toJSON().data)).toEqual({
      transactionId: 'transaction-1',
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'external-0',
      referenceExpiresAt: '2026-11-13T10:00:00.000Z',
    });
  });
});

describe('WagerTransactionFailed', () => {
  it('carries PROCESSING_FAILED', () => {
    const refund = bet({
      kind: 'REFUND',
      referenceExternalTransactionId: 'external-0',
    });
    refund.waitForReference();
    refund.markFailed(at);
    const event = WagerTransactionFailed.from(refund, ctx);
    expect(Object.keys(event.toJSON())).toEqual(ENVELOPE_KEYS);
    expect(wire(event)).toMatchObject({
      eventType: 'WagerTransactionFailed',
      aggregateId: 'transaction-1',
      version: 1,
      data: {
        transactionId: 'transaction-1',
        money: { amount: '25.00', currency: 'BRL' },
        failureCode: 'PROCESSING_FAILED',
      },
    });
  });

  it('refuses a transaction that is not FAILED', () => {
    expect(() => WagerTransactionFailed.from(bet(), ctx)).toThrow(
      InvariantViolationError,
    );
  });
});
