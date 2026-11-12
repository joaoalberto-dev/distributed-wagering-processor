import { Money, type MoneyProps } from '../money/money.js';

/**
 * The aggregate numbers the report needs, computed in SQL without loading the
 * entries. The reader may return more fields (for the Stretch issues).
 */
export type LedgerFigures = {
  /** The stored `wallets.balance`, as the decimal string PostgreSQL returns. */
  readonly storedBalance: string;
  readonly currency: string;
  /** The signed sum of the entries: credits minus debits, in minor units. */
  readonly ledgerSumMinor: bigint;
  readonly entryCount: number;
};

/** Core ships `BALANCE_MISMATCH`; the chain and version issues are Stretch. */
export type ReconciliationIssueCode = 'BALANCE_MISMATCH';

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
