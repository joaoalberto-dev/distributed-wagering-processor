import type { CircuitState } from '@nestjs/resilience';

/** Waits `ms`, or less if `signal` aborts; never rejects. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export type PollingLoopOptions = {
  /** Runs one cycle and returns how much work it found; zero means idle. */
  readonly cycle: () => Promise<number>;
  /** The wait after a cycle that found nothing, failed, or was skipped. */
  readonly idlePollMs: number;
  /** The circuits of the dependencies a cycle needs; any open one skips the cycle. */
  readonly circuits: readonly { readonly state: CircuitState }[];
  /** A cycle that threw; the loop waits the idle poll and goes on. */
  readonly onError: (error: unknown) => void;
  readonly sleep?: Sleep;
};

/**
 * The one polling loop of the consumer, the publisher, and the worker
 * (§17). It runs a cycle, runs the next one at once if work was found, and
 * otherwise waits the idle poll. While a needed circuit is open it skips
 * cycles; half-open runs the normal cycle, whose first call is the probe.
 * `stop` ends the loop and waits for the cycle in progress.
 */
export class PollingLoop {
  readonly #options: PollingLoopOptions;
  readonly #sleep: Sleep;
  #abort: AbortController | undefined;
  #running: Promise<void> | undefined;

  constructor(options: PollingLoopOptions) {
    this.#options = options;
    this.#sleep = options.sleep ?? realSleep;
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  start(): void {
    if (this.#running !== undefined) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#running = this.#loop(abort.signal);
  }

  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#running;
    this.#abort = undefined;
    this.#running = undefined;
  }

  async #loop(signal: AbortSignal): Promise<void> {
    const { cycle, idlePollMs, circuits, onError } = this.#options;
    while (!signal.aborted) {
      let found = 0;
      if (!circuits.some((circuit) => circuit.state === 'open')) {
        try {
          found = await cycle();
        } catch (error) {
          onError(error);
        }
      }
      if (found === 0 && !signal.aborted) {
        await this.#sleep(idlePollMs, signal);
      }
    }
  }
}
