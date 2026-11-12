import type {
  LogFieldUpdate,
  LogFields,
  RequestContext,
} from '../../../src/application/ports/request-context.js';

/** Keeps the fields set on it; `run` adds nothing, so tests read what the code set. */
export class FakeRequestContext implements RequestContext {
  fields: LogFields = {};

  run<T>(_fields: LogFieldUpdate, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  get(): LogFields {
    return this.fields;
  }
  set(fields: LogFieldUpdate): void {
    this.fields = { ...this.fields, ...(fields as LogFields) };
  }
}
