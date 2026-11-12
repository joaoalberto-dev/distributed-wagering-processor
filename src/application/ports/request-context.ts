/**
 * The identifiers every log line of an operation carries (§18). Amounts,
 * balances, and payloads are never among them.
 */
export type LogFields = {
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly messageId?: string;
  readonly sqsMessageId?: string;
  readonly transactionId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
  readonly instanceId?: string;
};

/** The fields of the operation in progress, carried across `await`s. */
export interface RequestContext {
  /** Runs `fn` with `fields` on top of the current context. */
  run<T>(fields: Partial<LogFields>, fn: () => Promise<T>): Promise<T>;
  /** The current fields; empty outside any `run`. */
  get(): LogFields;
  /** Adds fields to the current context, such as the wallet once it is known. */
  set(fields: Partial<LogFields>): void;
}

export const REQUEST_CONTEXT = Symbol('RequestContext');
