import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, Reflector } from '@nestjs/core';
import { SubmitWagerTransaction } from '../application/wagering/submit-wager-transaction.js';
import { WagerQueries } from '../application/wagering/wager-queries.js';
import { OpenWallet } from '../application/wallets/open-wallet.js';
import { ReconcileWallet } from '../application/wallets/reconcile-wallet.js';
import { ErrorFilter } from '../interface/http/error.filter.js';
import { ContractValidationPipe } from '../interface/http/validation.js';
import { WageringTransactionsController } from '../interface/http/wagering-transactions.controller.js';
import { WalletsController } from '../interface/http/wallets.controller.js';
import { BulkheadInterceptor } from './bulkhead.interceptor.js';
import type { Application } from './container.js';

/**
 * The HTTP contract for every route: validation, the error mapping, and the
 * bulkheads. The business controllers are mounted only when `HTTP_ENABLED`
 * is on; the operational endpoints are always served.
 */
@Module({})
export class HttpModule {
  static register(app: Application): DynamicModule {
    return {
      module: HttpModule,
      controllers: app.config.roles.http
        ? [WalletsController, WageringTransactionsController]
        : [],
      providers: [
        { provide: APP_PIPE, useValue: new ContractValidationPipe() },
        { provide: APP_FILTER, useValue: new ErrorFilter() },
        {
          provide: APP_INTERCEPTOR,
          useFactory: (reflector: Reflector) =>
            new BulkheadInterceptor(app.policies, reflector),
          inject: [Reflector],
        },
        { provide: OpenWallet, useValue: app.openWallet },
        { provide: ReconcileWallet, useValue: app.reconcileWallet },
        {
          provide: SubmitWagerTransaction,
          useValue: app.submitWagerTransaction,
        },
        { provide: WagerQueries, useValue: app.wagerQueries },
      ],
    };
  }
}
