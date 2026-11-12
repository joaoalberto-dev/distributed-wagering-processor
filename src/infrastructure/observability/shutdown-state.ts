import type { OnModuleDestroy } from '@nestjs/common';

/**
 * Whether the process is draining. Nest calls `onModuleDestroy` on every
 * module before any `beforeApplicationShutdown`, where the consumer and the
 * loops drain, so readiness answers 503 for the whole drain (§12, Shutdown)
 * while the HTTP server still serves.
 */
export class ShutdownState implements OnModuleDestroy {
  #draining = false;

  get draining(): boolean {
    return this.#draining;
  }

  onModuleDestroy(): void {
    this.#draining = true;
  }
}
