import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { AppLogger } from '../../application/ports/logger.js';
import type { RequestContext } from '../../application/ports/request-context.js';

type JsonOptions = Parameters<ConsoleLogger['getJsonLogObject']>[1];

/**
 * One JSON object per line, with the request-context IDs merged at the root
 * (§18). Callers pass identifiers and codes, never amounts or payloads.
 */
export class JsonLogger extends ConsoleLogger {
  constructor(
    private readonly requestContext: RequestContext,
    logLevels: LogLevel[],
  ) {
    super({ json: true, logLevels, flattenParams: true });
  }

  protected override getJsonLogObject(
    message: unknown,
    options: JsonOptions,
  ): ReturnType<ConsoleLogger['getJsonLogObject']> {
    const record = super.getJsonLogObject(message, options);
    // The record's own fields win over the context on a collision.
    return { ...this.requestContext.get(), ...record };
  }
}

/** The application's logger port over Nest's logger, under one context name. */
export class NestAppLogger implements AppLogger {
  constructor(
    private readonly logger: ConsoleLogger,
    private readonly context: string,
  ) {}

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.logger.warn(message, { ...fields }, this.context);
  }

  error(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.logger.error(message, { ...fields }, this.context);
  }
}

const SEVERITY: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/** The configured level and every level more severe than it. */
export function enabledLevels(level: LogLevel): LogLevel[] {
  return SEVERITY.slice(0, SEVERITY.indexOf(level) + 1);
}
