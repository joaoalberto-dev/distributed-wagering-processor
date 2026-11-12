import type { WagerSubmitter } from '../application/messaging/process-wager-message.js';

/** The error an `unexpected-on-wallet` fault raises: classified as Unexpected. */
export class InjectedFault extends Error {
  constructor(walletId: string) {
    super(`injected unexpected error for wallet ${walletId}`);
    this.name = 'InjectedFault';
  }
}

/** Ends the process the way a crash would: no shutdown hooks, no drain. */
export type Crash = () => never;

const sigkill: Crash = () => {
  process.kill(process.pid, 'SIGKILL');
  // SIGKILL cannot be caught; this only satisfies the type.
  throw new Error('the process survived SIGKILL');
};

/**
 * The fault points of the test harness (§19), parsed from `FAULT_INJECTION`.
 * The configuration refuses them outside `NODE_ENV=test`. With no point set,
 * every method does nothing.
 *
 * *   `crash-after-commit`: the consumer dies between commit and delete.
 * *   `crash-after-send`: the publisher dies between send and commit (task 10).
 * *   `unexpected-on-wallet:<id>`: every submission for that wallet fails
 *     with an unclassified error.
 */
export class FaultInjection {
  readonly #points: ReadonlySet<string>;
  readonly #unexpectedWallets: ReadonlySet<string>;

  constructor(
    points: readonly string[],
    private readonly crash: Crash = sigkill,
  ) {
    const normalized = points.map((point) => point.toLowerCase());
    this.#points = new Set(normalized);
    this.#unexpectedWallets = new Set(
      normalized
        .filter((point) => point.startsWith('unexpected-on-wallet:'))
        .map((point) => point.slice('unexpected-on-wallet:'.length)),
    );
  }

  get enabled(): boolean {
    return this.#points.size > 0;
  }

  crashAfterCommit(): void {
    if (this.#points.has('crash-after-commit')) this.crash();
  }

  crashAfterSend(): void {
    if (this.#points.has('crash-after-send')) this.crash();
  }

  /** The submitter, failing for the wallets of `unexpected-on-wallet`. */
  wrapSubmitter(submitter: WagerSubmitter): WagerSubmitter {
    if (this.#unexpectedWallets.size === 0) return submitter;
    return {
      execute: (command) =>
        this.#unexpectedWallets.has(command.operation.walletId)
          ? Promise.reject(new InjectedFault(command.operation.walletId))
          : submitter.execute(command),
    };
  }
}
