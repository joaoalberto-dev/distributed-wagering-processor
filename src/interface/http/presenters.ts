import type {
  LedgerItemView,
  WalletView,
} from '../../application/ports/queries.js';
import type { MoneyProps } from '../../domain/money/money.js';
import type {
  ReconciliationReport,
  ReconciliationReportJSON,
} from '../../domain/reconciliation/reconciliation-report.js';
import { encodeLedgerCursor } from '../../contracts/wallet.schemas.js';

/** `{ id, playerId, balance, version }`. */
export type WalletBody = {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
};

export type LedgerItemBody = {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
};

export type LedgerPageBody = {
  readonly items: readonly LedgerItemBody[];
  /** Null on the last page. */
  readonly nextCursor: string | null;
};

export function presentWallet(view: WalletView): WalletBody {
  return {
    id: view.id,
    playerId: view.playerId,
    balance: view.balance,
    version: view.version,
  };
}

/**
 * One ledger page. `items` were read with one row beyond `limit`: that row
 * only says another page exists, and is not returned.
 */
export function presentLedgerPage(
  items: readonly LedgerItemView[],
  limit: number,
): LedgerPageBody {
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((item) => ({
      id: item.id,
      transactionId: item.transactionId,
      direction: item.direction,
      amount: item.amount,
      balanceBefore: item.balanceBefore,
      balanceAfter: item.balanceAfter,
      walletVersion: item.walletVersion,
      createdAt: item.createdAt.toISOString(),
    })),
    nextCursor:
      items.length > limit && last !== undefined
        ? encodeLedgerCursor(last.walletVersion)
        : null,
  };
}

export function presentReconciliation(
  report: ReconciliationReport,
): ReconciliationReportJSON {
  return report.toJSON();
}
