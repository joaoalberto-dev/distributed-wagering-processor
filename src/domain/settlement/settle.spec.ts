import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction.js';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { Money } from '../money/money.js';
import { InvariantViolationError } from '../shared/domain-error.js';
import type { SubmittableKind } from '../transaction/transaction-kind.js';
import type { WagerTransactionStatus } from '../transaction/transaction-status.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../transaction/wager-transaction.js';
import { Wallet } from '../wallet/wallet.js';
import { type Decision, settle, type SettleInput } from './settle.js';

const at = new Date('2026-11-12T10:00:00.000Z');
const money = (amount: string, currency = 'BRL') =>
  Money.from({ amount, currency });

let sequence = 0;

function wallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency,
    balance: money(balance, currency),
    version: 5,
    createdAt: at,
    updatedAt: at,
  });
}

function operation(
  kind: SubmittableKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  return WagerTransaction.create({
    id: `transaction-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `external-${sequence}`,
    idempotencyKey: `key-${sequence}`,
    payloadHash: `v1:${sequence}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: money('25.00'),
    correlationId: 'correlation-1',
    at,
    ...overrides,
  });
}

/** A stored operation in the given status. */
function stored(
  kind: SubmittableKind,
  status: WagerTransactionStatus = 'PROCESSED',
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const base = operation(kind, {
    ...(kind === 'REFUND' || kind === 'ROLLBACK'
      ? { referenceExternalTransactionId: 'external-earlier' }
      : {}),
    ...overrides,
  });
  return WagerTransaction.rehydrate({ ...base.toState(), status });
}

/** The ledger entry of a processed reference. */
function entryOf(
  reference: WagerTransaction,
  direction: LedgerDirection,
): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: `entry-${reference.id}`,
    walletId: reference.walletId,
    transactionId: reference.id,
    direction,
    amount: reference.money,
    balanceBefore: money('0.00'),
    balanceAfter: reference.money,
    walletVersion: 2,
    createdAt: at,
  });
}

/** A processed reversal of `reference`. */
function reversalOf(
  reference: WagerTransaction,
  kind: 'REFUND' | 'ROLLBACK' = 'REFUND',
): WagerTransaction {
  const base = operation(kind, {
    referenceExternalTransactionId: reference.externalTransactionId ?? '',
    money: reference.money,
  });
  return WagerTransaction.rehydrate({
    ...base.toState(),
    status: 'PROCESSED',
    referenceTransactionId: reference.id,
  });
}

/** A pending operation that references `reference`. */
function referencing(
  kind: SubmittableKind,
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return operation(kind, {
    referenceExternalTransactionId: reference.externalTransactionId ?? '',
    money: reference.money,
    ...overrides,
  });
}

function input(
  overrides: Partial<SettleInput> & Pick<SettleInput, 'transaction'>,
): SettleInput {
  return {
    wallet: wallet(),
    reference: null,
    referenceEntry: null,
    existingReversal: null,
    ttlReached: false,
    ...overrides,
  };
}

const rejected = (
  failureCode: string,
  details?: Record<string, string>,
): Decision =>
  (details === undefined
    ? { kind: 'reject', failureCode }
    : { kind: 'reject', failureCode, details }) as Decision;

const credit = (amount: string) => ({
  direction: LedgerDirection.Credit,
  amount: money(amount),
});
const debit = (amount: string) => ({
  direction: LedgerDirection.Debit,
  amount: money(amount),
});

describe('settle: D2 and D3', () => {
  it('D2 rejects a wallet of another player, before the currency check', () => {
    const transaction = operation('BET', {
      playerId: 'player-2',
      money: money('25.00', 'USD'),
    });
    expect(settle(input({ transaction }))).toEqual(
      rejected('WALLET_PLAYER_MISMATCH'),
    );
  });

  it('D3 rejects a currency other than the wallet currency', () => {
    const transaction = operation('BET', { money: money('25.00', 'USD') });
    expect(settle(input({ transaction }))).toEqual(
      rejected('CURRENCY_MISMATCH'),
    );
  });

  it('D3 also applies to a wallet in another currency', () => {
    const transaction = operation('WIN');
    expect(
      settle(input({ transaction, wallet: wallet('10.00', 'USD') })),
    ).toEqual(rejected('CURRENCY_MISMATCH'));
  });
});

describe('settle: D4, an absent reference', () => {
  it.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const)(
    '%s waits before the TTL and is REFERENCE_NOT_FOUND at it',
    (kind) => {
      const transaction = operation(kind, {
        referenceExternalTransactionId: 'external-missing',
      });
      expect(settle(input({ transaction }))).toEqual({ kind: 'wait' });
      expect(settle(input({ transaction, ttlReached: true }))).toEqual(
        rejected('REFERENCE_NOT_FOUND'),
      );
    },
  );

  it('does not wait for a WIN or LOSS sent without a reference', () => {
    expect(settle(input({ transaction: operation('WIN') }))).toEqual({
      kind: 'process',
      effect: credit('25.00'),
    });
    expect(settle(input({ transaction: operation('LOSS') }))).toEqual({
      kind: 'process',
      effect: null,
    });
  });
});

describe('settle: D5, the reference belongs to the same operation', () => {
  it.each([
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['currency', { money: money('25.00', 'USD') }],
    ['roundId', { roundId: 'round-2' }],
  ] as const)('names %s when it differs', (field, overrides) => {
    const reference = stored('BET', 'PROCESSED', overrides);
    const transaction = referencing('REFUND', reference, {
      money: money('25.00'),
    });
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_MISMATCH', { field }),
    );
  });

  it('names the first differing field in order', () => {
    const reference = stored('BET', 'PROCESSED', {
      roundId: 'round-2',
      walletId: 'wallet-2',
      playerId: 'player-2',
    });
    const transaction = referencing('WIN', reference);
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_MISMATCH', { field: 'playerId' }),
    );
  });

  it('comes before the kind check', () => {
    const reference = stored('WIN', 'PROCESSED', { roundId: 'round-2' });
    const transaction = referencing('REFUND', reference);
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_MISMATCH', { field: 'roundId' }),
    );
  });
});

describe('settle: D6, the allowed reference kinds', () => {
  it.each([
    ['WIN', 'WIN'],
    ['WIN', 'REFUND'],
    ['LOSS', 'LOSS'],
    ['LOSS', 'WIN'],
    ['REFUND', 'WIN'],
    ['REFUND', 'REFUND'],
    ['REFUND', 'LOSS'],
    ['ROLLBACK', 'LOSS'],
    ['ROLLBACK', 'ROLLBACK'],
  ] as const)('%s may not reference %s', (kind, referenceKind) => {
    const reference = stored(referenceKind);
    const transaction = referencing(kind, reference);
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_INVALID'),
    );
  });

  it('comes before the amount check', () => {
    const reference = stored('WIN', 'PROCESSED', { money: money('5.00') });
    const transaction = referencing('REFUND', reference, {
      money: money('6.00'),
    });
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_INVALID'),
    );
  });
});

describe('settle: D7, a reversal amount equals the reference amount', () => {
  it.each(['REFUND', 'ROLLBACK'] as const)('%s with another amount', (kind) => {
    const reference = stored('BET');
    const transaction = referencing(kind, reference, {
      money: money('24.99'),
    });
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_MISMATCH', { field: 'amount' }),
    );
  });

  it('does not apply to a WIN, whose amount is its own', () => {
    const reference = stored('BET');
    const transaction = referencing('WIN', reference, {
      money: money('80.00'),
    });
    expect(settle(input({ transaction, reference }))).toEqual({
      kind: 'process',
      effect: credit('80.00'),
    });
  });
});

describe('settle: D8, the reference status', () => {
  it.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const)(
    '%s waits on a pending reference, and is REFERENCE_NOT_READY at the TTL',
    (kind) => {
      const reference = stored('BET', 'PENDING_REFERENCE');
      const transaction = referencing(kind, reference);
      expect(settle(input({ transaction, reference }))).toEqual({
        kind: 'wait',
      });
      expect(
        settle(input({ transaction, reference, ttlReached: true })),
      ).toEqual(rejected('REFERENCE_NOT_READY'));
    },
  );

  it.each(['REJECTED', 'FAILED'] as const)(
    'rejects a %s reference as REFERENCE_NOT_PROCESSED',
    (status) => {
      const reference = stored('BET', status);
      const transaction = referencing('REFUND', reference);
      expect(settle(input({ transaction, reference }))).toEqual(
        rejected('REFERENCE_NOT_PROCESSED'),
      );
    },
  );

  it('comes after the amount check', () => {
    const reference = stored('BET', 'REJECTED');
    const transaction = referencing('REFUND', reference, {
      money: money('1.00'),
    });
    expect(settle(input({ transaction, reference }))).toEqual(
      rejected('REFERENCE_MISMATCH', { field: 'amount' }),
    );
  });
});

describe('settle: D9, one successful reversal per transaction', () => {
  it.each([
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['ROLLBACK', 'REFUND'],
    ['ROLLBACK', 'ROLLBACK'],
  ] as const)(
    'rejects a %s after a %s as REFERENCE_ALREADY_REVERSED',
    (kind, earlier) => {
      const reference = stored('BET');
      const existingReversal = reversalOf(reference, earlier);
      const transaction = referencing(kind, reference);
      expect(
        settle(
          input({
            transaction,
            reference,
            referenceEntry: entryOf(reference, LedgerDirection.Debit),
            existingReversal,
          }),
        ),
      ).toEqual(
        rejected('REFERENCE_ALREADY_REVERSED', {
          referenceReversedBy: existingReversal.id,
        }),
      );
    },
  );

  it('processes a WIN after a REFUND of its BET, flagged with referenceReversedBy', () => {
    const bet = stored('BET');
    const refund = reversalOf(bet, 'REFUND');
    const win = referencing('WIN', bet, { money: money('60.00') });
    expect(
      settle(
        input({ transaction: win, reference: bet, existingReversal: refund }),
      ),
    ).toEqual({
      kind: 'process',
      effect: credit('60.00'),
      details: { referenceReversedBy: refund.id },
    });
  });

  it('processes a REFUND after a WIN on the same BET', () => {
    const bet = stored('BET');
    // The WIN was processed first; it does not reverse the BET.
    const refund = referencing('REFUND', bet);
    expect(settle(input({ transaction: refund, reference: bet }))).toEqual({
      kind: 'process',
      effect: credit('25.00'),
    });
  });

  it('processes a LOSS after a ROLLBACK of its BET, flagged, with no effect', () => {
    const bet = stored('BET');
    const rollback = reversalOf(bet, 'ROLLBACK');
    const loss = referencing('LOSS', bet, { money: money('0.00') });
    expect(
      settle(
        input({
          transaction: loss,
          reference: bet,
          existingReversal: rollback,
        }),
      ),
    ).toEqual({
      kind: 'process',
      effect: null,
      details: { referenceReversedBy: rollback.id },
    });
  });

  it('allows a ROLLBACK of a REFUND whose BET was refunded', () => {
    const refund = stored('REFUND');
    const rollback = referencing('ROLLBACK', refund);
    expect(
      settle(
        input({
          transaction: rollback,
          reference: refund,
          referenceEntry: entryOf(refund, LedgerDirection.Credit),
        }),
      ),
    ).toEqual({ kind: 'process', effect: debit('25.00') });
  });

  it('refuses an existing reversal that does not reverse the reference', () => {
    const bet = stored('BET');
    const unrelated = reversalOf(stored('BET'));
    expect(() =>
      settle(
        input({
          transaction: referencing('REFUND', bet),
          reference: bet,
          existingReversal: unrelated,
        }),
      ),
    ).toThrow(InvariantViolationError);
  });
});

describe('settle: D10, funds', () => {
  it('rejects a BET above the balance as INSUFFICIENT_FUNDS', () => {
    const transaction = operation('BET', { money: money('100.01') });
    expect(settle(input({ transaction }))).toEqual(
      rejected('INSUFFICIENT_FUNDS'),
    );
  });

  it('processes a BET of the whole balance', () => {
    const transaction = operation('BET', { money: money('100.00') });
    expect(settle(input({ transaction }))).toEqual({
      kind: 'process',
      effect: debit('100.00'),
    });
  });

  it('rejects a ROLLBACK debit above the balance as REVERSAL_INSUFFICIENT_FUNDS', () => {
    const win = stored('WIN', 'PROCESSED', { money: money('500.00') });
    const transaction = referencing('ROLLBACK', win);
    expect(
      settle(
        input({
          transaction,
          reference: win,
          referenceEntry: entryOf(win, LedgerDirection.Credit),
        }),
      ),
    ).toEqual(rejected('REVERSAL_INSUFFICIENT_FUNDS'));
  });
});

describe('settle: D11, the ceiling', () => {
  it('rejects a WIN above the ceiling as BALANCE_LIMIT_EXCEEDED', () => {
    const transaction = operation('WIN', { money: money('0.01') });
    expect(
      settle(input({ transaction, wallet: wallet('999999999999.99') })),
    ).toEqual(rejected('BALANCE_LIMIT_EXCEEDED'));
  });

  it('rejects a ROLLBACK credit above the ceiling as BALANCE_LIMIT_EXCEEDED', () => {
    const bet = stored('BET');
    const transaction = referencing('ROLLBACK', bet);
    expect(
      settle(
        input({
          transaction,
          wallet: wallet('999999999999.00'),
          reference: bet,
          referenceEntry: entryOf(bet, LedgerDirection.Debit),
        }),
      ),
    ).toEqual(rejected('BALANCE_LIMIT_EXCEEDED'));
  });

  it('processes a credit up to the ceiling', () => {
    const transaction = operation('WIN', { money: money('0.99') });
    expect(
      settle(input({ transaction, wallet: wallet('999999999999.00') })).kind,
    ).toBe('process');
  });
});

describe('settle: effects by kind', () => {
  it('BET debits', () => {
    expect(settle(input({ transaction: operation('BET') }))).toEqual({
      kind: 'process',
      effect: debit('25.00'),
    });
  });

  it('WIN against its BET credits', () => {
    const bet = stored('BET');
    expect(
      settle(input({ transaction: referencing('WIN', bet), reference: bet })),
    ).toEqual({ kind: 'process', effect: credit('25.00') });
  });

  it('REFUND credits', () => {
    const bet = stored('BET');
    expect(
      settle(
        input({ transaction: referencing('REFUND', bet), reference: bet }),
      ),
    ).toEqual({ kind: 'process', effect: credit('25.00') });
  });

  it.each(['0.00', '25.00'])('LOSS of %s has no effect', (amount) => {
    const bet = stored('BET');
    const loss = referencing('LOSS', bet, { money: money(amount) });
    expect(settle(input({ transaction: loss, reference: bet }))).toEqual({
      kind: 'process',
      effect: null,
    });
  });

  it.each([
    ['BET', LedgerDirection.Debit, credit('25.00')],
    ['WIN', LedgerDirection.Credit, debit('25.00')],
    ['REFUND', LedgerDirection.Credit, debit('25.00')],
  ] as const)(
    'ROLLBACK of a %s inverts its entry',
    (referenceKind, direction, effect) => {
      const reference = stored(referenceKind);
      expect(
        settle(
          input({
            transaction: referencing('ROLLBACK', reference),
            reference,
            referenceEntry: entryOf(reference, direction),
          }),
        ),
      ).toEqual({ kind: 'process', effect });
    },
  );

  it('OPENING credits', () => {
    const opening = WagerTransaction.open({
      id: 'transaction-opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: money('100.00'),
      correlationId: 'correlation-1',
      at,
    });
    expect(
      settle(input({ transaction: opening, wallet: wallet('0.00') })),
    ).toEqual({ kind: 'process', effect: credit('100.00') });
  });
});

describe('settle: purity and preconditions', () => {
  it('mutates neither the transaction nor the wallet', () => {
    const transaction = operation('BET');
    const target = wallet();
    const before = [transaction.toState(), target.toState()];
    settle(input({ transaction, wallet: target }));
    expect([transaction.toState(), target.toState()]).toEqual(before);
  });

  it('re-runs for a PENDING_REFERENCE transaction in the worker', () => {
    const bet = stored('BET');
    const refund = WagerTransaction.rehydrate({
      ...referencing('REFUND', bet).toState(),
      status: 'PENDING_REFERENCE',
      attempts: 4,
    });
    expect(settle(input({ transaction: refund, reference: bet })).kind).toBe(
      'process',
    );
  });

  it('refuses a terminal transaction', () => {
    const transaction = stored('BET', 'PROCESSED');
    expect(() => settle(input({ transaction }))).toThrow(
      InvariantViolationError,
    );
  });

  it('refuses a wallet other than the transaction wallet', () => {
    const transaction = operation('BET', { walletId: 'wallet-2' });
    expect(() => settle(input({ transaction }))).toThrow(
      InvariantViolationError,
    );
  });

  it('refuses a reference not resolved by its external ID', () => {
    const bet = stored('BET');
    const transaction = operation('REFUND', {
      referenceExternalTransactionId: 'external-other',
    });
    expect(() => settle(input({ transaction, reference: bet }))).toThrow(
      InvariantViolationError,
    );
  });

  it('refuses a ROLLBACK without its reference entry', () => {
    const bet = stored('BET');
    expect(() =>
      settle(
        input({ transaction: referencing('ROLLBACK', bet), reference: bet }),
      ),
    ).toThrow(InvariantViolationError);
  });
});
