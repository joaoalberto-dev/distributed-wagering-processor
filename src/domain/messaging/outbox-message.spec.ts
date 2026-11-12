import { describe, expect, it } from 'bun:test';
import { WagerTransactionProcessed } from '../events/wager-events.js';
import { Money } from '../money/money.js';
import { InvalidTransitionError } from '../shared/domain-error.js';
import { WagerTransaction } from '../transaction/wager-transaction.js';
import { InboxMessage } from './inbox-message.js';
import { OutboxMessage } from './outbox-message.js';

const at = new Date('2026-11-12T10:00:00.000Z');
const later = new Date('2026-11-12T10:00:05.000Z');

function processedEvent(): WagerTransactionProcessed {
  const transaction = WagerTransaction.create({
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
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    correlationId: 'correlation-1',
    at,
  });
  transaction.markProcessed({
    balance: Money.from({ amount: '75.00', currency: 'BRL' }),
    at,
  });
  return WagerTransactionProcessed.from(transaction, {
    eventId: 'event-1',
    correlationId: 'correlation-1',
    causationId: 'provider-a:external-1',
    occurredAt: at,
  });
}

describe('OutboxMessage', () => {
  it('enqueues an event with its envelope as the payload', () => {
    const event = processedEvent();
    const message = OutboxMessage.enqueue(event);
    expect(message.toState()).toEqual({
      id: 'event-1',
      aggregateId: 'transaction-1',
      walletId: 'wallet-1',
      eventType: 'WagerTransactionProcessed',
      eventVersion: 1,
      payload: event.toJSON(),
      occurredAt: at,
      attempts: 0,
      publishedAt: null,
      lastError: null,
    });
    expect(message.isPublished()).toBe(false);
  });

  it('backs off 1 s, doubling, up to 5 min, counting each attempt', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    const delays = Array.from({ length: 12 }, () =>
      message.scheduleRetry('throttled', () => 1),
    );
    expect(delays).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000,
      300_000, 300_000,
    ]);
    expect(message.attempts).toBe(12);
    expect(message.lastError).toBe('throttled');
  });

  it('jitters each delay within [delay/2, delay]', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    expect(message.scheduleRetry('error', () => 0)).toBe(500);
    expect(message.scheduleRetry('error', () => 0.5)).toBe(1500);
  });

  it('can be published after retries', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.scheduleRetry('error', () => 1);
    message.markPublished(later);
    expect(message.isPublished()).toBe(true);
    expect(message.publishedAt).toBe(later);
    expect(message.attempts).toBe(1);
  });

  it('refuses scheduleRetry and markPublished once published', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.markPublished(later);
    expect(() => message.scheduleRetry('error')).toThrow(
      InvalidTransitionError,
    );
    expect(() => message.markPublished(later)).toThrow(InvalidTransitionError);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBe(later);
  });

  it('rehydrates persisted state as is', () => {
    const state = {
      ...OutboxMessage.enqueue(processedEvent()).toState(),
      attempts: 7,
      lastError: 'timeout',
    };
    expect(OutboxMessage.rehydrate(state).toState()).toEqual(state);
  });
});

describe('InboxMessage', () => {
  const message = InboxMessage.receive({
    consumerName: 'wager-transactions-consumer',
    messageId: 'msg-123',
    payloadHash: 'v1:abc',
    idempotencyKey: 'provider-a:external-1',
    transactionId: 'transaction-1',
    at,
  });

  it('is received and processed at the same time', () => {
    expect(message.receivedAt).toBe(at);
    expect(message.processedAt).toBe(at);
  });

  it('matches only the same payload hash and idempotency key', () => {
    expect(message.matches('v1:abc', 'provider-a:external-1')).toBe(true);
    expect(message.matches('v1:other', 'provider-a:external-1')).toBe(false);
    expect(message.matches('v1:abc', 'provider-a:external-2')).toBe(false);
  });

  it('round-trips through rehydrate', () => {
    expect(InboxMessage.rehydrate(message.toState()).toState()).toEqual(
      message.toState(),
    );
  });
});
