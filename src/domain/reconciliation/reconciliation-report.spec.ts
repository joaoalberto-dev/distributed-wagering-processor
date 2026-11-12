import { describe, expect, it } from 'bun:test';
import {
  type LedgerFigures,
  ReconciliationReport,
} from './reconciliation-report.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

/** A consistent wallet opened at 100.00 with 41 later entries, at 975.00. */
function figures(overrides: Partial<LedgerFigures> = {}): LedgerFigures {
  return {
    storedBalance: '975.00',
    currency: 'BRL',
    storedVersion: 42,
    ledgerSumMinor: 97_500n,
    entryCount: 42,
    minVersion: 1,
    maxVersion: 42,
    hasOpening: true,
    missingVersions: [],
    firstBalanceBefore: '0.00',
    chainBreaks: 0,
    ...overrides,
  };
}

/** A wallet opened at zero: version 1, no entries. */
const emptyWallet = figures({
  storedBalance: '0.00',
  storedVersion: 1,
  ledgerSumMinor: 0n,
  entryCount: 0,
  minVersion: null,
  maxVersion: null,
  hasOpening: false,
  firstBalanceBefore: null,
});

describe('ReconciliationReport', () => {
  it('reports a consistent wallet', () => {
    const report = ReconciliationReport.build(walletId, figures());
    expect(report.toJSON()).toEqual({
      walletId,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 42,
      issues: [],
    });
  });

  it('reports a wallet opened at zero, with no entries, as consistent', () => {
    const report = ReconciliationReport.build(walletId, emptyWallet);
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(0);
    expect(report.difference.isZero()).toBe(true);
  });

  it('reports a wallet opened at zero whose first entry is version 2 as consistent', () => {
    const report = ReconciliationReport.build(
      walletId,
      figures({ hasOpening: false, minVersion: 2, entryCount: 41 }),
    );
    expect(report.issues).toEqual([]);
  });

  describe('BALANCE_MISMATCH', () => {
    it('reports a stored balance above the ledger with a positive difference', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ storedBalance: '1000.00' }),
      );
      expect(report.consistent).toBe(false);
      expect(report.issues).toEqual([{ code: 'BALANCE_MISMATCH' }]);
      expect(report.toJSON().difference).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });
    });

    it('reports a stored balance below the ledger with a negative difference', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ storedBalance: '950.00' }),
      );
      expect(report.issues).toEqual([{ code: 'BALANCE_MISMATCH' }]);
      expect(report.toJSON().difference).toEqual({
        amount: '-25.00',
        currency: 'BRL',
      });
    });

    it('reports a corrupted ledger whose sum is negative', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ storedBalance: '0.00', ledgerSumMinor: -1n }),
      );
      expect(report.toJSON()).toMatchObject({
        calculatedBalance: { amount: '-0.01', currency: 'BRL' },
        difference: { amount: '0.01', currency: 'BRL' },
        consistent: false,
      });
    });
  });

  describe('VERSION_MISMATCH', () => {
    it('reports a stored version different from the highest entry version', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ storedVersion: 40 }),
      );
      expect(report.issues).toEqual([
        {
          code: 'VERSION_MISMATCH',
          details: { storedVersion: 40, expectedVersion: 42 },
        },
      ]);
    });

    it('expects version 1 when there are no entries', () => {
      const report = ReconciliationReport.build(walletId, {
        ...emptyWallet,
        storedVersion: 3,
      });
      expect(report.issues).toEqual([
        {
          code: 'VERSION_MISMATCH',
          details: { storedVersion: 3, expectedVersion: 1 },
        },
      ]);
    });
  });

  describe('CHAIN_GAP', () => {
    it('reports a missing version in the middle of the chain', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ entryCount: 41, missingVersions: [7] }),
      );
      expect(report.issues).toEqual([
        {
          code: 'CHAIN_GAP',
          details: {
            expectedFirstVersion: 1,
            firstVersion: 1,
            missingVersions: [7],
          },
        },
      ]);
    });

    it('reports a chain that starts above its expected first version', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({
          hasOpening: false,
          minVersion: 3,
          entryCount: 40,
          missingVersions: [2],
        }),
      );
      expect(report.issues).toEqual([
        {
          code: 'CHAIN_GAP',
          details: {
            expectedFirstVersion: 2,
            firstVersion: 3,
            missingVersions: [2],
          },
        },
      ]);
    });

    it('reports a version-1 entry that is not an opening', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ hasOpening: false }),
      );
      expect(report.issues.map((issue) => issue.code)).toEqual(['CHAIN_GAP']);
    });
  });

  describe('CHAIN_BREAK', () => {
    it('reports a balance_before that does not continue the previous entry', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ chainBreaks: 2 }),
      );
      expect(report.issues).toEqual([
        {
          code: 'CHAIN_BREAK',
          details: { startsAtZero: true, brokenLinks: 2 },
        },
      ]);
    });

    it('reports a chain that does not start from zero', () => {
      const report = ReconciliationReport.build(
        walletId,
        figures({ firstBalanceBefore: '5.00' }),
      );
      expect(report.issues).toEqual([
        {
          code: 'CHAIN_BREAK',
          details: { startsAtZero: false, brokenLinks: 0 },
        },
      ]);
    });
  });

  it('reports every issue found, in a fixed order', () => {
    const report = ReconciliationReport.build(
      walletId,
      figures({
        storedBalance: '1.00',
        storedVersion: 1,
        entryCount: 41,
        missingVersions: [7],
        chainBreaks: 1,
      }),
    );
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'BALANCE_MISMATCH',
      'VERSION_MISMATCH',
      'CHAIN_GAP',
      'CHAIN_BREAK',
    ]);
  });
});
