import type { AppLogger } from '../../../src/application/ports/logger.js';

export type LogLine = {
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

export class RecordingLogger implements AppLogger {
  readonly warnings: LogLine[] = [];
  readonly errors: LogLine[] = [];

  warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.warnings.push({ message, fields });
  }

  error(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.errors.push({ message, fields });
  }
}
