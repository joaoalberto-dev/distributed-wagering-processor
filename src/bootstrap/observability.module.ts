import { type DynamicModule, Module } from '@nestjs/common';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { ID_GENERATOR } from '../application/ports/id-generator.js';
import { REQUEST_CONTEXT } from '../application/ports/request-context.js';
import { DatabaseGauges } from '../infrastructure/observability/database-gauges.js';
import { HealthController } from '../infrastructure/observability/health.controller.js';
import { ReadinessIndicators } from '../infrastructure/observability/indicators.js';
import { ShutdownState } from '../infrastructure/observability/shutdown-state.js';
import { MetricsController } from '../infrastructure/observability/metrics.controller.js';
import { Metrics } from '../infrastructure/observability/metrics.js';
import type { Application } from './container.js';

/**
 * The operational endpoints (`/health/*`, `/metrics`), served by every
 * instance whatever its role flags, and the request-context ports the
 * HTTP middleware and controllers inject.
 */
@Module({})
export class ObservabilityModule {
  static register(app: Application): DynamicModule {
    return {
      module: ObservabilityModule,
      global: true,
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: Metrics, useValue: app.metrics },
        { provide: DatabaseGauges, useValue: app.gauges },
        ShutdownState,
        { provide: REQUEST_CONTEXT, useValue: app.requestContext },
        { provide: ID_GENERATOR, useValue: app.ids },
        {
          provide: ReadinessIndicators,
          useFactory: (health: HealthIndicatorService) =>
            new ReadinessIndicators(app.orm, app.sqs, app.queues, health),
          inject: [HealthIndicatorService],
        },
      ],
      exports: [REQUEST_CONTEXT, ID_GENERATOR],
    };
  }
}
