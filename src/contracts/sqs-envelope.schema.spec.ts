import { describe, expect, it } from 'bun:test';
import { sqsEnvelope } from './sqs-envelope.schema.js';

const ENVELOPE = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
};

/** The issue paths of a rejected envelope, or null when it is accepted. */
function issuesOf(input: unknown): string[] | null {
  const result = sqsEnvelope.safeParse(input);
  return result.success
    ? null
    : result.error.issues.map((i) => i.path.join('.'));
}

describe('sqsEnvelope', () => {
  it('accepts the challenge example and returns it unchanged', () => {
    expect(sqsEnvelope.parse(ENVELOPE)).toEqual(ENVELOPE as never);
  });

  it('accepts an occurredAt with an offset', () => {
    expect(
      issuesOf({ ...ENVELOPE, occurredAt: '2026-07-29T12:00:00-03:00' }),
    ).toBeNull();
  });

  it('rejects an unknown field in the envelope', () => {
    expect(issuesOf({ ...ENVELOPE, attempt: 1 })).toEqual(['']);
  });

  it('rejects an unknown field in data', () => {
    expect(
      issuesOf({ ...ENVELOPE, data: { ...ENVELOPE.data, note: 'x' } }),
    ).toEqual(['data']);
  });

  it('rejects an unknown field in data.money', () => {
    expect(
      issuesOf({
        ...ENVELOPE,
        data: { ...ENVELOPE.data, money: { ...ENVELOPE.data.money, scale: 2 } },
      }),
    ).toEqual(['data.money']);
  });

  it('rejects another type', () => {
    expect(issuesOf({ ...ENVELOPE, type: 'WalletOpened' })).toEqual(['type']);
  });

  it('rejects a missing data.idempotencyKey', () => {
    const { idempotencyKey: _, ...data } = ENVELOPE.data;
    expect(issuesOf({ ...ENVELOPE, data })).toEqual(['data.idempotencyKey']);
  });

  it('rejects a messageId outside the external-ID format', () => {
    expect(issuesOf({ ...ENVELOPE, messageId: 'msg 123' })).toEqual([
      'messageId',
    ]);
  });

  it('rejects an occurredAt that is not an ISO date-time', () => {
    expect(issuesOf({ ...ENVELOPE, occurredAt: '29/07/2026' })).toEqual([
      'occurredAt',
    ]);
  });

  it('applies the operation rules to data', () => {
    expect(
      issuesOf({ ...ENVELOPE, data: { ...ENVELOPE.data, kind: 'REFUND' } }),
    ).toEqual(['data.referenceExternalTransactionId']);
  });
});
