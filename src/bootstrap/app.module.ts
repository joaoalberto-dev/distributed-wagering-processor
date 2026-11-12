import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../infrastructure/config/app-config.js';
import { HealthController } from '../infrastructure/observability/health.controller.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
