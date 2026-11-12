import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseGauges } from './database-gauges.js';
import { Metrics } from './metrics.js';

/** Prometheus exposition; no authentication (challenge §9). */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(DatabaseGauges) private readonly gauges: DatabaseGauges,
  ) {}

  @Get()
  async scrape(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    await this.gauges.refresh();
    response.type(this.metrics.contentType);
    return this.metrics.render();
  }
}
