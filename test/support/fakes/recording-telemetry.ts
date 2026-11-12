import type { Telemetry } from '../../../src/application/ports/telemetry.js';

export type TelemetryCall = {
  readonly method: keyof Telemetry;
  readonly args: unknown[];
};

/** Records every metric call, in order. */
export class RecordingTelemetry implements Telemetry {
  readonly calls: TelemetryCall[] = [];

  /** The argument lists of every call to `method`. */
  of(method: keyof Telemetry): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  #record(method: keyof Telemetry, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  transactionDecided(...args: Parameters<Telemetry['transactionDecided']>) {
    this.#record('transactionDecided', args);
  }
  processingDuration(...args: Parameters<Telemetry['processingDuration']>) {
    this.#record('processingDuration', args);
  }
  idempotentReplay(...args: Parameters<Telemetry['idempotentReplay']>) {
    this.#record('idempotentReplay', args);
  }
  idempotencyConflict(...args: Parameters<Telemetry['idempotencyConflict']>) {
    this.#record('idempotencyConflict', args);
  }
  inboxDuplicate() {
    this.#record('inboxDuplicate', []);
  }
  messageIdConflict() {
    this.#record('messageIdConflict', []);
  }
  uniqueViolationRetry() {
    this.#record('uniqueViolationRetry', []);
  }
  referenceAttempt(...args: Parameters<Telemetry['referenceAttempt']>) {
    this.#record('referenceAttempt', args);
  }
  referenceFailed() {
    this.#record('referenceFailed', []);
  }
  reconciliationDivergence(
    ...args: Parameters<Telemetry['reconciliationDivergence']>
  ) {
    this.#record('reconciliationDivergence', args);
  }
  settlementOnReversedReference() {
    this.#record('settlementOnReversedReference', []);
  }
  outboxPublishAttempt(...args: Parameters<Telemetry['outboxPublishAttempt']>) {
    this.#record('outboxPublishAttempt', args);
  }
}
