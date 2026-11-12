import { type DynamicModule, Module } from '@nestjs/common';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { CLOCK } from '../application/ports/clock.js';
import { ID_GENERATOR } from '../application/ports/id-generator.js';
import { PROVIDER_IDENTITY } from '../application/ports/provider-identity.js';
import { REQUEST_CONTEXT } from '../application/ports/request-context.js';
import { TELEMETRY } from '../application/ports/telemetry.js';
import { HealthController } from '../infrastructure/observability/health.controller.js';
import { ReadinessIndicators } from '../infrastructure/observability/indicators.js';
import { MetricsController } from '../infrastructure/observability/metrics.controller.js';
import { Metrics } from '../infrastructure/observability/metrics.js';
import type { Application } from './container.js';

/**
 * The operational endpoints (`/health/*`, `/metrics`), served by every
 * instance whatever its role flags, and the cross-cutting ports.
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
        { provide: TELEMETRY, useValue: app.metrics },
        { provide: REQUEST_CONTEXT, useValue: app.requestContext },
        { provide: ID_GENERATOR, useValue: app.ids },
        { provide: CLOCK, useValue: app.clock },
        { provide: PROVIDER_IDENTITY, useValue: app.providerIdentity },
        {
          provide: ReadinessIndicators,
          useFactory: (health: HealthIndicatorService) =>
            new ReadinessIndicators(app.orm, health),
          inject: [HealthIndicatorService],
        },
      ],
      exports: [
        TELEMETRY,
        REQUEST_CONTEXT,
        ID_GENERATOR,
        CLOCK,
        PROVIDER_IDENTITY,
      ],
    };
  }
}
