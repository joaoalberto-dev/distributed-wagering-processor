import { Controller, Get, Inject, SetMetadata } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ROUTE_GROUP } from '../../application/ports/route-group.js';
import { ReadinessIndicators } from './indicators.js';
import { ShutdownState } from './shutdown-state.js';

/** Operational endpoints; no authentication (challenge §9). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(ReadinessIndicators)
    private readonly indicators: ReadinessIndicators,
    @Inject(ShutdownState) private readonly shutdown: ShutdownState,
  ) {}

  /** The process answers; no dependency is checked, so no bulkhead either. */
  @Get('live')
  @SetMetadata(ROUTE_GROUP, 'none')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * PostgreSQL, SQS, and the schema version; 503 names the failing check.
   * While draining, 503 names `shutdown` and no dependency is checked.
   */
  @Get('ready')
  @SetMetadata(ROUTE_GROUP, 'readiness')
  @HealthCheck()
  ready() {
    if (this.shutdown.draining) {
      return this.health.check([() => this.indicators.draining()]);
    }
    return this.health.check([
      () => this.indicators.postgres(),
      () => this.indicators.sqsQueue(),
      () => this.indicators.migrations(),
    ]);
  }
}
