import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  LogFieldUpdate,
  LogFields,
  RequestContext,
} from '../../application/ports/request-context.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The request context on `AsyncLocalStorage`: each `run` opens a scope that
 * inherits the enclosing fields, and `set` adds to the current scope only.
 */
export class AsyncLocalRequestContext implements RequestContext {
  readonly #storage = new AsyncLocalStorage<Mutable<LogFields>>();

  /** `base` is in every scope, such as the `instanceId`. */
  constructor(private readonly base: LogFields = {}) {}

  run<T>(fields: LogFieldUpdate, fn: () => Promise<T>): Promise<T> {
    return this.#storage.run({ ...this.get(), ...defined(fields) }, fn);
  }

  get(): LogFields {
    return { ...this.base, ...this.#storage.getStore() };
  }

  set(fields: LogFieldUpdate): void {
    const store = this.#storage.getStore();
    if (store !== undefined) Object.assign(store, defined(fields));
  }

  /**
   * Opens a scope for the rest of the current synchronous call and the
   * asynchronous work it starts, for middleware that cannot wrap `next()`.
   */
  enter(fields: LogFieldUpdate): void {
    this.#storage.enterWith({ ...this.get(), ...defined(fields) });
  }
}

function defined(fields: LogFieldUpdate): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
