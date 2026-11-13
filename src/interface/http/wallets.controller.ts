import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  SetMetadata,
} from '@nestjs/common';
import { InvalidCursor, WalletNotFound } from '../../application/errors.js';
import { QUERY_PORT, type QueryPort } from '../../application/ports/queries.js';
import {
  REQUEST_CONTEXT,
  type RequestContext,
} from '../../application/ports/request-context.js';
import { ROUTE_GROUP } from '../../application/ports/route-group.js';
import { OpenWallet } from '../../application/wallets/open-wallet.js';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet.js';
import {
  decodeLedgerCursor,
  type LedgerQuery,
  ledgerQuery,
  type OpenWalletBody,
  openWalletBody,
  walletIdParam,
} from '../../contracts/wallet.schemas.js';
import { Money } from '../../domain/money/money.js';
import type { ReconciliationReportJSON } from '../../domain/reconciliation/reconciliation-report.js';
import { correlationIdOf } from './correlation-id.js';
import {
  type LedgerPageBody,
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
  type WalletBody,
} from './presenters.js';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(QUERY_PORT) private readonly queries: QueryPort,
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
  ) {}

  @Post()
  async open(
    @Body({ schema: openWalletBody }) body: OpenWalletBody,
  ): Promise<WalletBody> {
    const view = await this.openWallet.execute({
      playerId: body.playerId,
      initialBalance: Money.from(body.initialBalance),
      correlationId: correlationIdOf(this.context),
    });
    return presentWallet(view);
  }

  @Get(':walletId')
  async get(
    @Param('walletId', { schema: walletIdParam }) walletId: string,
  ): Promise<WalletBody> {
    this.context.set({ walletId });
    const view = await this.queries.wallet(walletId);
    if (view === null) throw new WalletNotFound(walletId);
    return presentWallet(view);
  }

  /** Ascending by `walletVersion`; `nextCursor` is null on the last page. */
  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', { schema: walletIdParam }) walletId: string,
    @Query({ schema: ledgerQuery }) query: LedgerQuery,
  ): Promise<LedgerPageBody> {
    this.context.set({ walletId });
    const after =
      query.cursor === undefined ? 0 : decodeLedgerCursor(query.cursor);
    if (after === null) throw new InvalidCursor();
    if ((await this.queries.wallet(walletId)) === null) {
      throw new WalletNotFound(walletId);
    }
    const items = await this.queries.ledgerPage(
      walletId,
      after,
      query.limit + 1,
    );
    return presentLedgerPage(items, query.limit);
  }

  /** 200 even when inconsistent; the report says so (§14). */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @SetMetadata(ROUTE_GROUP, 'reconciliation')
  async reconcile(
    @Param('walletId', { schema: walletIdParam }) walletId: string,
  ): Promise<ReconciliationReportJSON> {
    this.context.set({ walletId });
    return presentReconciliation(await this.reconcileWallet.execute(walletId));
  }
}
