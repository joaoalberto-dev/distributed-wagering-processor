import 'reflect-metadata';
import { type LogLevel as NestLogLevel, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  type LogLevel,
  loadConfig,
} from '../infrastructure/config/app-config.js';
import { AppModule } from './app.module.js';

const SEVERITY: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/** The configured level and every level more severe than it. */
function enabledLevels(level: LogLevel): NestLogLevel[] {
  return SEVERITY.slice(0, SEVERITY.indexOf(level) + 1);
}

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule.register(config), {
    logger: enabledLevels(config.logLevel),
  });
  app.enableShutdownHooks();
  await app.listen(config.port);
  Logger.log(
    `Instance ${config.instanceId} listening on port ${config.port}`,
    'Bootstrap',
  );
}

await bootstrap();
