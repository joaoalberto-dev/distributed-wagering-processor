import { describe, expect, it } from 'bun:test';
import { ReconciliationReport } from './reconciliation-report.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

describe('ReconciliationReport', () => {
  it('reports a consistent wallet', () => {
    const report = ReconciliationReport.build(walletId, {
      storedBalance: '975.00',
      currency: 'BRL',
      ledgerSumMinor: 97_500n,
      entryCount: 42,
    });
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
    const report = ReconciliationReport.build(walletId, {
      storedBalance: '0.00',
      currency: 'BRL',
      ledgerSumMinor: 0n,
      entryCount: 0,
    });
    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(0);
    expect(report.difference.isZero()).toBe(true);
  });

  it('reports a stored balance above the ledger with a positive difference', () => {
    const report = ReconciliationReport.build(walletId, {
      storedBalance: '1000.00',
      currency: 'BRL',
      ledgerSumMinor: 97_500n,
      entryCount: 42,
    });
    expect(report.consistent).toBe(false);
    expect(report.issues).toEqual([{ code: 'BALANCE_MISMATCH' }]);
    expect(report.toJSON().difference).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('reports a stored balance below the ledger with a negative difference', () => {
    const report = ReconciliationReport.build(walletId, {
      storedBalance: '950.00',
      currency: 'BRL',
      ledgerSumMinor: 97_500n,
      entryCount: 42,
    });
    expect(report.issues).toEqual([{ code: 'BALANCE_MISMATCH' }]);
    expect(report.toJSON().difference).toEqual({
      amount: '-25.00',
      currency: 'BRL',
    });
  });

  it('reports a corrupted ledger whose sum is negative', () => {
    const report = ReconciliationReport.build(walletId, {
      storedBalance: '0.00',
      currency: 'BRL',
      ledgerSumMinor: -1n,
      entryCount: 3,
    });
    expect(report.toJSON()).toMatchObject({
      calculatedBalance: { amount: '-0.01', currency: 'BRL' },
      difference: { amount: '0.01', currency: 'BRL' },
      consistent: false,
    });
  });
});
