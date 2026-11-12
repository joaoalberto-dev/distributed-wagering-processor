import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ReadinessIndicators } from './indicators.js';

/** Operational endpoints; no authentication (challenge §9). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(ReadinessIndicators)
    private readonly indicators: ReadinessIndicators,
  ) {}

  /** The process answers; no dependency is checked. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL and the schema version; 503 names the failing check. SQS joins in task 09. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.indicators.postgres(),
      () => this.indicators.migrations(),
    ]);
  }
}
