import { Money, type MoneyProps } from '../money/money.js';

/**
 * The aggregate numbers the report needs, computed in SQL without loading the
 * entries.
 */
export type LedgerFigures = {
  /** The stored `wallets.balance`, as the decimal string PostgreSQL returns. */
  readonly storedBalance: string;
  readonly currency: string;
  /** The stored `wallets.version`. */
  readonly storedVersion: number;
  /** The signed sum of the entries: credits minus debits, in minor units. */
  readonly ledgerSumMinor: bigint;
  readonly entryCount: number;
  /** The lowest and highest `wallet_version`; null when there are no entries. */
  readonly minVersion: number | null;
  readonly maxVersion: number | null;
  /** Whether an `OPENING` entry exists, which makes 1 the first version. */
  readonly hasOpening: boolean;
  /**
   * Versions absent between the expected first version and `maxVersion`, in
   * order. The reader may cap the list; `CHAIN_GAP` does not depend on it.
   */
  readonly missingVersions: readonly number[];
  /** The first entry's `balance_before`; null when there are no entries. */
  readonly firstBalanceBefore: string | null;
  /** Entries whose `balance_before` differs from the previous `balance_after`. */
  readonly chainBreaks: number;
};

export type ReconciliationIssueCode =
  | 'BALANCE_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'CHAIN_GAP'
  | 'CHAIN_BREAK';

export type ReconciliationIssue = {
  readonly code: ReconciliationIssueCode;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ReconciliationReportJSON = {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly issues: readonly ReconciliationIssue[];
};

/**
 * Compares a wallet's stored balance with the balance rebuilt from its ledger.
 * It reports and never corrects.
 */
export class ReconciliationReport {
  private constructor(
    readonly walletId: string,
    readonly storedBalance: Money,
    readonly calculatedBalance: Money,
    readonly checkedEntries: number,
    readonly issues: readonly ReconciliationIssue[],
  ) {}

  static build(walletId: string, figures: LedgerFigures): ReconciliationReport {
    const stored = Money.from({
      amount: figures.storedBalance,
      currency: figures.currency,
    });
    const calculated = Money.ofMinor(figures.ledgerSumMinor, figures.currency);
    const issues: ReconciliationIssue[] = [];
    if (!stored.equals(calculated)) issues.push({ code: 'BALANCE_MISMATCH' });
    const version = versionMismatch(figures);
    if (version !== null) issues.push(version);
    const gap = chainGap(figures);
    if (gap !== null) issues.push(gap);
    const chain = chainBreak(figures);
    if (chain !== null) issues.push(chain);
    return new ReconciliationReport(
      walletId,
      stored,
      calculated,
      figures.entryCount,
      Object.freeze(issues),
    );
  }

  /** `stored − calculated`, signed. */
  get difference(): Money {
    return this.storedBalance.subtract(this.calculatedBalance);
  }

  /** True only when there are no issues. */
  get consistent(): boolean {
    return this.issues.length === 0;
  }

  toJSON(): ReconciliationReportJSON {
    return {
      walletId: this.walletId,
      storedBalance: this.storedBalance.toProps(),
      calculatedBalance: this.calculatedBalance.toProps(),
      difference: this.difference.toProps(),
      consistent: this.consistent,
      checkedEntries: this.checkedEntries,
      issues: this.issues,
    };
  }
}

/** The stored version must be the highest entry version, or 1 with no entries. */
function versionMismatch(figures: LedgerFigures): ReconciliationIssue | null {
  const expectedVersion = figures.maxVersion ?? 1;
  if (figures.storedVersion === expectedVersion) return null;
  return {
    code: 'VERSION_MISMATCH',
    details: { storedVersion: figures.storedVersion, expectedVersion },
  };
}

/**
 * Versions must be contiguous and start at 1 when an `OPENING` entry exists,
 * else at 2 (a wallet opened at zero holds version 1 with no entry).
 */
function chainGap(figures: LedgerFigures): ReconciliationIssue | null {
  const { minVersion, maxVersion, entryCount } = figures;
  if (minVersion === null || maxVersion === null) return null;
  const expectedFirstVersion = figures.hasOpening ? 1 : 2;
  const contiguous = entryCount === maxVersion - minVersion + 1;
  if (contiguous && minVersion === expectedFirstVersion) return null;
  return {
    code: 'CHAIN_GAP',
    details: {
      expectedFirstVersion,
      firstVersion: minVersion,
      missingVersions: figures.missingVersions,
    },
  };
}

/**
 * The chain starts from zero, and each `balance_before` equals the previous
 * entry's `balance_after`.
 */
function chainBreak(figures: LedgerFigures): ReconciliationIssue | null {
  const first = figures.firstBalanceBefore;
  const startsAtZero =
    first === null ||
    Money.from({ amount: first, currency: figures.currency }).isZero();
  if (startsAtZero && figures.chainBreaks === 0) return null;
  return {
    code: 'CHAIN_BREAK',
    details: { startsAtZero, brokenLinks: figures.chainBreaks },
  };
}
