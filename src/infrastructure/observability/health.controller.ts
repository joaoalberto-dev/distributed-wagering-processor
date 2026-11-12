import { Controller, Get } from '@nestjs/common';

/** Operational endpoints. Readiness is added with the database (task 05). */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
