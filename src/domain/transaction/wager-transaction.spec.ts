import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money.js';
import {
  InvalidTransitionError,
  InvariantViolationError,
} from '../shared/domain-error.js';
import {
  canTransition,
  isTerminal,
  WagerTransactionStatus,
} from './transaction-status.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from './wager-transaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-12T10:00:00.000Z');
const later = new Date('2026-11-12T10:01:00.000Z');

function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
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
  };
}

function inStatus(status: WagerTransactionStatus): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...WagerTransaction.create(props()).toState(),
    status,
  });
}

type MoveName =
  | 'markProcessed'
  | 'markRejected'
  | 'waitForReference'
  | 'reschedule'
  | 'markFailed';

const moves: Record<MoveName, (transaction: WagerTransaction) => void> = {
  markProcessed: (t) => t.markProcessed({ balance: brl('75.00'), at: later }),
  markRejected: (t) =>
    t.markRejected({
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
      at: later,
    }),
  waitForReference: (t) => {
    t.waitForReference(() => 1);
  },
  reschedule: (t) => {
    t.reschedule(() => 1);
  },
  markFailed: (t) => t.markFailed(later),
};

const allowed: Record<WagerTransactionStatus, readonly MoveName[]> = {
  PENDING: ['markProcessed', 'markRejected', 'waitForReference'],
  PENDING_REFERENCE: [
    'markProcessed',
    'markRejected',
    'reschedule',
    'markFailed',
  ],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

const expectedStatus: Record<MoveName, WagerTransactionStatus> = {
  markProcessed: 'PROCESSED',
  markRejected: 'REJECTED',
  waitForReference: 'PENDING_REFERENCE',
  reschedule: 'PENDING_REFERENCE',
  markFailed: 'FAILED',
};

const statuses = Object.values(WagerTransactionStatus);
const cases = statuses.flatMap((status) =>
  (Object.keys(moves) as MoveName[]).map((move) => ({
    status,
    move,
    ok: allowed[status].includes(move),
  })),
);

describe('WagerTransaction transitions', () => {
  it.each(cases.filter((c) => c.ok))(
    'allows $move from $status',
    ({ status, move }) => {
      const transaction = inStatus(status);
      moves[move](transaction);
      expect(transaction.status).toBe(expectedStatus[move]);
    },
  );

  it.each(cases.filter((c) => !c.ok))(
    'refuses $move from $status',
    ({ status, move }) => {
      const transaction = inStatus(status);
      const before = transaction.toState();
      expect(() => moves[move](transaction)).toThrow(InvalidTransitionError);
      expect(transaction.toState()).toEqual(before);
    },
  );

  it('matches the status edge table', () => {
    expect(canTransition('PENDING', 'PROCESSED')).toBe(true);
    expect(canTransition('PENDING', 'FAILED')).toBe(false);
    expect(canTransition('PENDING_REFERENCE', 'PENDING')).toBe(false);
    expect(canTransition('PROCESSED', 'PROCESSED')).toBe(false);
    expect(statuses.filter(isTerminal)).toEqual([
      'PROCESSED',
      'REJECTED',
      'FAILED',
    ]);
  });

  it('records the result of markProcessed', () => {
    const transaction = WagerTransaction.create(
      props({ kind: 'WIN', referenceExternalTransactionId: 'external-0' }),
    );
    transaction.markProcessed({
      balance: brl('125.00'),
      referenceTransactionId: 'transaction-0',
      details: { referenceReversedBy: 'transaction-r' },
      at: later,
    });
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.referenceTransactionId).toBe('transaction-0');
    expect(transaction.resultBalance?.toProps().amount).toBe('125.00');
    expect(transaction.resultDetails).toEqual({
      referenceReversedBy: 'transaction-r',
    });
    expect(transaction.failureCode).toBeNull();
    expect(transaction.processedAt).toBe(later);
  });

  it('records the result of markRejected', () => {
    const transaction = WagerTransaction.create(props());
    transaction.markRejected({
      failureCode: 'REFERENCE_MISMATCH',
      balance: brl('10.00'),
      details: { field: 'roundId' },
      at: later,
    });
    expect(transaction.failureCode).toBe('REFERENCE_MISMATCH');
    expect(transaction.resultDetails).toEqual({ field: 'roundId' });
    expect(transaction.resultBalance?.toProps().amount).toBe('10.00');
    expect(transaction.processedAt).toBe(later);
  });

  it('refuses PROCESSING_FAILED as a rejection code', () => {
    const transaction = WagerTransaction.create(props());
    expect(() =>
      transaction.markRejected({
        failureCode: 'PROCESSING_FAILED' as 'INSUFFICIENT_FUNDS',
        balance: brl('0.00'),
        at: later,
      }),
    ).toThrow(InvariantViolationError);
    expect(transaction.status).toBe('PENDING');
  });

  it('records FAILED with PROCESSING_FAILED and no balance', () => {
    const transaction = inStatus('PENDING_REFERENCE');
    transaction.markFailed(later);
    expect(transaction.failureCode).toBe('PROCESSING_FAILED');
    expect(transaction.resultBalance).toBeNull();
    expect(transaction.processedAt).toBe(later);
  });

  it('returns delays, counting worker attempts only on reschedule', () => {
    const transaction = WagerTransaction.create(
      props({ kind: 'REFUND', referenceExternalTransactionId: 'external-0' }),
    );
    expect(transaction.waitForReference(() => 1)).toBe(1000);
    expect(transaction.attempts).toBe(0);
    expect(transaction.resultBalance).toBeNull();
    expect(transaction.reschedule(() => 1)).toBe(1000);
    expect(transaction.reschedule(() => 1)).toBe(2000);
    expect(transaction.reschedule(() => 0)).toBe(2000);
    expect(transaction.attempts).toBe(3);
  });
});

describe('WagerTransaction.create', () => {
  it('starts PENDING with no result', () => {
    const transaction = WagerTransaction.create(props());
    expect(transaction.status).toBe('PENDING');
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.attempts).toBe(0);
    expect(transaction.resultBalance).toBeNull();
    expect(transaction.failureCode).toBeNull();
    expect(transaction.referenceExternalTransactionId).toBeNull();
    expect(transaction.createdAt).toBe(at);
  });

  it('rejects OPENING', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: 'OPENING' as 'BET' })),
    ).toThrow(InvariantViolationError);
  });

  it.each(['REFUND', 'ROLLBACK'] as const)(
    'requires a reference for %s',
    (kind) => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(
        InvariantViolationError,
      );
    },
  );

  it('forbids a reference on BET', () => {
    expect(() =>
      WagerTransaction.create(
        props({ kind: 'BET', referenceExternalTransactionId: 'external-0' }),
      ),
    ).toThrow(InvariantViolationError);
  });

  it.each(['WIN', 'LOSS'] as const)(
    'makes the reference optional for %s',
    (kind) => {
      expect(WagerTransaction.create(props({ kind })).status).toBe('PENDING');
      expect(
        WagerTransaction.create(
          props({ kind, referenceExternalTransactionId: 'external-0' }),
        ).referenceExternalTransactionId,
      ).toBe('external-0');
    },
  );

  it('forbids a self-reference', () => {
    expect(() =>
      WagerTransaction.create(
        props({ kind: 'REFUND', referenceExternalTransactionId: 'external-1' }),
      ),
    ).toThrow(InvariantViolationError);
  });

  it.each(['BET', 'WIN'] as const)(
    'requires a positive amount for %s',
    (kind) => {
      expect(() =>
        WagerTransaction.create(props({ kind, money: brl('0.00') })),
      ).toThrow(InvariantViolationError);
    },
  );

  it('allows a zero LOSS and refuses a negative one', () => {
    expect(
      WagerTransaction.create(
        props({ kind: 'LOSS', money: brl('0.00') }),
      ).money.isZero(),
    ).toBe(true);
    expect(() =>
      WagerTransaction.create(props({ kind: 'LOSS', money: brl('-1.00') })),
    ).toThrow(InvariantViolationError);
  });

  it('compares the payload hash', () => {
    const transaction = WagerTransaction.create(props());
    expect(transaction.matchesPayload('v1:abc')).toBe(true);
    expect(transaction.matchesPayload('v1:other')).toBe(false);
  });
});

describe('WagerTransaction.open', () => {
  it('creates an OPENING credit with no provider fields', () => {
    const transaction = WagerTransaction.open({
      id: 'transaction-0',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('100.00'),
      correlationId: 'correlation-1',
      at,
    });
    expect(transaction.kind).toBe('OPENING');
    expect(transaction.status).toBe('PENDING');
    expect(transaction.providerId).toBeNull();
    expect(transaction.externalTransactionId).toBeNull();
    expect(transaction.idempotencyKey).toBeNull();
    expect(transaction.payloadHash).toBeNull();
    expect(transaction.roundId).toBeNull();
    expect(transaction.gameId).toBeNull();
    expect(transaction.referenceExternalTransactionId).toBeNull();
  });

  it('refuses a zero opening; a zero opening has no transaction', () => {
    expect(() =>
      WagerTransaction.open({
        id: 'transaction-0',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('0.00'),
        correlationId: 'correlation-1',
        at,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('rebuilds a terminal row without re-validating, and round-trips', () => {
    const state = {
      ...WagerTransaction.create(props()).toState(),
      status: 'REJECTED' as const,
      failureCode: 'INSUFFICIENT_FUNDS' as const,
      resultBalance: brl('1.00'),
      processedAt: later,
    };
    const transaction = WagerTransaction.rehydrate(state);
    expect(transaction.toState()).toEqual(state);
    expect(transaction.isTerminal()).toBe(true);
  });
});
