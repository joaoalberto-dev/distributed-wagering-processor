import type { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import { TransactionNotFound } from '../errors.js';
import type { QueryPort, TransactionView } from '../ports/queries.js';

/** The transaction resource of an aggregate, as the read side would return it. */
export function toTransactionView(
  transaction: WagerTransaction,
): TransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toProps(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    status: transaction.status,
    failureCode: transaction.failureCode,
    details: transaction.resultDetails,
    resultBalance: transaction.resultBalance?.toProps() ?? null,
    attempts: transaction.attempts,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt,
  };
}

/** The two transaction reads (§7, Routes): no lock, `TransactionNotFound` when absent. */
export class WagerQueries {
  constructor(private readonly queries: QueryPort) {}

  async byId(id: string): Promise<TransactionView> {
    return found(await this.queries.transaction(id));
  }

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    return found(
      await this.queries.transactionByExternalId(
        providerId,
        externalTransactionId,
      ),
    );
  }
}

function found(view: TransactionView | null): TransactionView {
  if (view === null) throw new TransactionNotFound();
  return view;
}
