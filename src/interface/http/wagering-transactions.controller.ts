import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  REQUEST_CONTEXT,
  type RequestContext,
} from '../../application/ports/request-context.js';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction.js';
import { WagerQueries } from '../../application/wagering/wager-queries.js';
import {
  externalIdParam,
  idempotencyKeyHeader,
  transactionIdParam,
  type WagerOperationBody,
  wagerOperation,
} from '../../contracts/wager-operation.schema.js';
import { RequestHeader } from './request-header.decorator.js';
import {
  presentResult,
  presentTransaction,
  resultStatus,
  type TransactionBody,
  type TransactionResultBody,
  transactionLocation,
} from './transaction-presenter.js';

@Controller()
export class WageringTransactionsController {
  constructor(
    @Inject(SubmitWagerTransaction)
    private readonly submitTransaction: SubmitWagerTransaction,
    @Inject(WagerQueries) private readonly queries: WagerQueries,
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
  ) {}

  /**
   * 200, 202 with `Location`, or 422, from the stored state; a replay
   * answers the same way with `idempotentReplay: true`.
   */
  @Post('wagering/transactions')
  async submit(
    @Body({ schema: wagerOperation }) body: WagerOperationBody,
    @RequestHeader('idempotency-key', { schema: idempotencyKeyHeader })
    idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransactionResultBody> {
    const result = await this.submitTransaction.execute({
      operation: body,
      idempotencyKey,
      channel: 'http',
      correlationId: this.correlationId(),
      causationId: idempotencyKey,
    });
    const view = result.transaction;
    response.status(resultStatus(view));
    if (view.status === 'PENDING_REFERENCE') {
      response.setHeader('Location', transactionLocation(view));
    }
    return presentResult(view, result.replay);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(
    @Param('transactionId', { schema: transactionIdParam })
    transactionId: string,
  ): Promise<TransactionBody> {
    this.context.set({ transactionId });
    return presentTransaction(await this.queries.byId(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId', { schema: externalIdParam }) providerId: string,
    @Param('externalTransactionId', { schema: externalIdParam })
    externalTransactionId: string,
  ): Promise<TransactionBody> {
    this.context.set({ providerId });
    return presentTransaction(
      await this.queries.byExternalId(providerId, externalTransactionId),
    );
  }

  private correlationId(): string {
    const { correlationId } = this.context.get();
    if (correlationId === undefined) {
      throw new Error('the request context has no correlation ID');
    }
    return correlationId;
  }
}
