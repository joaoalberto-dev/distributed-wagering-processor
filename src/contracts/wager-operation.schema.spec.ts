import { describe, expect, it } from 'bun:test';
import {
  idempotencyKeyHeader,
  wagerOperation,
  wagerOperationData,
} from './wager-operation.schema.js';

const BET = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const REFUND = {
  ...BET,
  kind: 'REFUND',
  referenceExternalTransactionId: 'transaction-1',
};

/** The issue paths of a rejected input, or null when it is accepted. */
function issuesOf(input: unknown, schema = wagerOperation): string[] | null {
  const result = schema.safeParse(input);
  return result.success
    ? null
    : result.error.issues.map((i) => i.path.join('.'));
}

describe('wagerOperation', () => {
  it('accepts a valid operation of each kind and returns it unchanged', () => {
    expect(wagerOperation.parse(BET)).toEqual(BET as never);
    expect(issuesOf(REFUND)).toBeNull();
    expect(issuesOf({ ...REFUND, kind: 'ROLLBACK' })).toBeNull();
    expect(issuesOf({ ...BET, kind: 'WIN' })).toBeNull();
    expect(issuesOf({ ...REFUND, kind: 'WIN' })).toBeNull();
  });

  describe('V1: strict', () => {
    it('rejects an unknown field', () => {
      expect(issuesOf({ ...BET, note: 'x' })).toEqual(['']);
    });
    it('rejects an unknown field inside money', () => {
      expect(issuesOf({ ...BET, money: { ...BET.money, scale: 2 } })).toEqual([
        'money',
      ]);
    });
    it('rejects an explicit null, even for the optional reference', () => {
      expect(
        issuesOf({ ...BET, kind: 'WIN', referenceExternalTransactionId: null }),
      ).toEqual(['referenceExternalTransactionId']);
    });
    it('rejects a missing required field', () => {
      const { gameId: _, ...noGame } = BET;
      expect(issuesOf(noGame)).toEqual(['gameId']);
    });
  });

  describe('V2: ID formats', () => {
    it('accepts the full external ID alphabet at 128 characters', () => {
      expect(
        issuesOf({
          ...BET,
          externalTransactionId: `aZ0._:-${'x'.repeat(121)}`,
        }),
      ).toBeNull();
    });
    it('rejects an external ID over 128 characters or with a space', () => {
      expect(
        issuesOf({ ...BET, externalTransactionId: 'x'.repeat(129) }),
      ).toEqual(['externalTransactionId']);
      expect(issuesOf({ ...BET, roundId: 'round 1' })).toEqual(['roundId']);
    });
    it('rejects an uppercase UUID', () => {
      expect(
        issuesOf({ ...BET, walletId: BET.walletId.toUpperCase() }),
      ).toEqual(['walletId']);
    });
  });

  describe('V3: amount grammar, sign, and ceiling', () => {
    it('accepts the ceiling', () => {
      expect(
        issuesOf({
          ...BET,
          money: { amount: '999999999999.99', currency: 'BRL' },
        }),
      ).toBeNull();
    });
    it('rejects a number, a lenient string, a negative, and the ceiling plus a cent', () => {
      for (const amount of [25, '25', '25.5', '-1.00', '1000000000000.00']) {
        expect(
          issuesOf({ ...BET, money: { amount, currency: 'BRL' } }),
        ).toEqual(['money.amount']);
      }
    });
  });

  describe('V4: kind', () => {
    it('accepts every submittable kind', () => {
      expect(issuesOf({ ...BET, kind: 'LOSS' })).toBeNull();
    });
    it('rejects OPENING', () => {
      expect(issuesOf({ ...BET, kind: 'OPENING' })).toEqual(['kind']);
    });
  });

  describe('V5: reference presence by kind', () => {
    it('accepts a WIN and a LOSS with or without a reference', () => {
      expect(
        issuesOf({
          ...BET,
          kind: 'LOSS',
          referenceExternalTransactionId: 't-1',
        }),
      ).toBeNull();
      expect(issuesOf({ ...BET, kind: 'LOSS' })).toBeNull();
    });
    it('rejects a REFUND or ROLLBACK without one, and a BET with one', () => {
      expect(issuesOf({ ...BET, kind: 'REFUND' })).toEqual([
        'referenceExternalTransactionId',
      ]);
      expect(issuesOf({ ...BET, kind: 'ROLLBACK' })).toEqual([
        'referenceExternalTransactionId',
      ]);
      expect(
        issuesOf({ ...BET, referenceExternalTransactionId: 't-1' }),
      ).toEqual(['referenceExternalTransactionId']);
    });
  });

  describe('V6: amount by kind', () => {
    it('accepts a LOSS of 0.00', () => {
      expect(
        issuesOf({
          ...BET,
          kind: 'LOSS',
          money: { amount: '0.00', currency: 'BRL' },
        }),
      ).toBeNull();
    });
    it('rejects 0.00 for every other kind', () => {
      for (const operation of [
        BET,
        { ...BET, kind: 'WIN' },
        REFUND,
        { ...REFUND, kind: 'ROLLBACK' },
      ]) {
        expect(
          issuesOf({
            ...operation,
            money: { amount: '0.00', currency: 'BRL' },
          }),
        ).toEqual(['money.amount']);
      }
    });
  });

  describe('V7: no self-reference', () => {
    it('accepts a reference to another operation', () => {
      expect(issuesOf(REFUND)).toBeNull();
    });
    it('rejects a reference to the operation itself', () => {
      expect(
        issuesOf({
          ...REFUND,
          referenceExternalTransactionId: REFUND.externalTransactionId,
        }),
      ).toEqual(['referenceExternalTransactionId']);
    });
  });
});

describe('wagerOperationData', () => {
  it('accepts the operation with its idempotency key', () => {
    expect(
      issuesOf(
        { ...BET, idempotencyKey: 'provider-a:transaction-123' },
        wagerOperationData,
      ),
    ).toBeNull();
  });
  it('requires the key and applies the same kind rules', () => {
    expect(issuesOf(BET, wagerOperationData)).toEqual(['idempotencyKey']);
    expect(
      issuesOf(
        { ...BET, kind: 'REFUND', idempotencyKey: 'k' },
        wagerOperationData,
      ),
    ).toEqual(['referenceExternalTransactionId']);
    expect(
      issuesOf({ ...BET, idempotencyKey: 'k', extra: 1 }, wagerOperationData),
    ).toEqual(['']);
  });
});

describe('idempotencyKeyHeader', () => {
  it('accepts 1–255 printable ASCII characters', () => {
    expect(
      idempotencyKeyHeader.safeParse('provider-a:transaction-123').success,
    ).toBe(true);
    expect(idempotencyKeyHeader.safeParse('~'.repeat(255)).success).toBe(true);
  });
  it('rejects a missing, empty, too long, or spaced key', () => {
    for (const key of [undefined, '', 'x'.repeat(256), 'a b']) {
      expect(idempotencyKeyHeader.safeParse(key).success).toBe(false);
    }
  });
});
