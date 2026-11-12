import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Metrics } from './metrics.js';

/** Prometheus exposition; no authentication (challenge §9). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  @Get()
  async scrape(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    response.type(this.metrics.contentType);
    return this.metrics.render();
  }
}
