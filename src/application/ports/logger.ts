/**
 * Structured application logs. The adapter adds the request-context fields;
 * callers pass identifiers and codes only, never amounts or payloads (§18).
 */
export interface AppLogger {
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export const APP_LOGGER = Symbol('AppLogger');
