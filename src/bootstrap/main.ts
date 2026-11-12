import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '../infrastructure/config/app-config.js';
import { AppModule } from './app.module.js';
import { buildApplication } from './container.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await buildApplication(config);
  const nest = await NestFactory.create(AppModule.register(app), {
    logger: app.logger,
  });
  nest.enableShutdownHooks();
  await nest.listen(config.port);
  Logger.log(
    `Instance ${config.instanceId} listening on port ${config.port}`,
    'Bootstrap',
  );
}

await bootstrap();
