import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { RequestContextMiddleware } from '../interface/http/request-context.middleware.js';
import type { Application } from './container.js';
import { HttpModule } from './http.module.js';
import { MessagingModule } from './messaging.module.js';
import { ObservabilityModule } from './observability.module.js';
import { PersistenceModule } from './persistence.module.js';
import { WorkersModule } from './workers.module.js';

@Module({})
export class AppModule implements NestModule {
  static register(app: Application): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PersistenceModule.register(app),
        ObservabilityModule.register(app),
        HttpModule.register(app),
        WorkersModule.register(),
        MessagingModule.register(),
      ],
    };
  }

  /** Every request, operational ones included, runs in its own context. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
