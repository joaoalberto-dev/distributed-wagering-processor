import { ReconciliationReport } from '../../domain/reconciliation/reconciliation-report.js';
import { WalletNotFound } from '../errors.js';
import type { AppLogger } from '../ports/logger.js';
import type { Telemetry } from '../ports/telemetry.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/**
 * Compares a wallet's stored balance with its ledger (§14), in one read-only
 * snapshot with SQL aggregates. It reports and never corrects: a divergence
 * is logged without amounts and counted per issue.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly telemetry: Telemetry,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const figures = await this.unitOfWork.run(
      (tx) => tx.reconciliation.aggregate(walletId),
      { retryContention: true, mode: 'read-only-snapshot' },
    );
    if (figures === null) throw new WalletNotFound(walletId);

    const report = ReconciliationReport.build(walletId, figures);
    if (!report.consistent) {
      const codes = report.issues.map((issue) => issue.code);
      for (const code of codes) this.telemetry.reconciliationDivergence(code);
      this.logger.warn('reconciliation found divergences', {
        walletId,
        issues: codes,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
