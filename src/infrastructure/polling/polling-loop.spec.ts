import { afterEach, describe, expect, it } from 'bun:test';
import type { CircuitState } from '@nestjs/resilience';
import { PollingLoop, realSleep } from './polling-loop.js';

/** Settles every pending promise callback. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A sleep that ends only when the test releases it, or on abort. */
class FakeSleep {
  readonly waits: { ms: number; release: () => void }[] = [];

  readonly sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      this.waits.push({ ms, release: resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

  get pending(): number[] {
    return this.waits.map((w) => w.ms);
  }

  async release(): Promise<void> {
    this.waits.shift()?.release();
    await settle();
  }
}

/** A cycle that answers from a script and records its calls. */
class ScriptedCycle {
  calls = 0;
  results: (number | Error)[] = [];
  /** While set, the cycle waits for it before answering. */
  gate: Promise<void> | undefined;

  readonly run = async (): Promise<number> => {
    this.calls += 1;
    await this.gate;
    const next = this.results.shift() ?? 0;
    if (next instanceof Error) throw next;
    return next;
  };
}

let loop: PollingLoop | undefined;
let sleep: FakeSleep;
let cycle: ScriptedCycle;
let errors: unknown[];
let circuit: { state: CircuitState };

function startLoop(): PollingLoop {
  sleep = new FakeSleep();
  cycle = new ScriptedCycle();
  errors = [];
  circuit = { state: 'closed' };
  loop = new PollingLoop({
    cycle: cycle.run,
    idlePollMs: 500,
    circuits: [circuit],
    onError: (error) => errors.push(error),
    sleep: sleep.sleep,
  });
  return loop;
}

afterEach(async () => {
  await loop?.stop();
  loop = undefined;
});

describe('PollingLoop', () => {
  it('runs the next cycle at once after work, and waits the idle poll after none', async () => {
    const polling = startLoop();
    cycle.results = [3, 1, 0];

    polling.start();
    await settle();

    expect(cycle.calls).toBe(3);
    expect(sleep.pending).toEqual([500]);

    await sleep.release();
    expect(cycle.calls).toBe(4);
    expect(sleep.pending).toEqual([500]);
  });

  it('skips cycles while a needed circuit is open', async () => {
    const polling = startLoop();
    circuit.state = 'open';

    polling.start();
    await settle();
    await sleep.release();
    await sleep.release();

    expect(cycle.calls).toBe(0);
    expect(sleep.pending).toEqual([500]);
  });

  it('runs the normal cycle when the circuit is half-open, as the probe', async () => {
    const polling = startLoop();
    circuit.state = 'open';
    polling.start();
    await settle();

    circuit.state = 'half-open';
    await sleep.release();

    expect(cycle.calls).toBe(1);
  });

  it('reports a failed cycle and waits the idle poll before the next', async () => {
    const polling = startLoop();
    const failure = new Error('cycle failed');
    cycle.results = [failure];

    polling.start();
    await settle();

    expect(errors).toEqual([failure]);
    expect(cycle.calls).toBe(1);
    expect(sleep.pending).toEqual([500]);
    await sleep.release();
    expect(cycle.calls).toBe(2);
  });

  it('on stop, waits for the cycle in progress and starts no other', async () => {
    const polling = startLoop();
    let open = () => {};
    cycle.gate = new Promise((resolve) => {
      open = resolve;
    });
    cycle.results = [5];
    polling.start();
    await settle();
    expect(cycle.calls).toBe(1);

    let stopped = false;
    const stopping = polling.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    open();
    await stopping;
    expect(cycle.calls).toBe(1);
    expect(polling.running).toBe(false);
  });

  it('on stop, ends an idle wait at once', async () => {
    const polling = startLoop();
    polling.start();
    await settle();
    expect(sleep.pending).toEqual([500]);

    await polling.stop();

    expect(cycle.calls).toBe(1);
    expect(polling.running).toBe(false);
  });
});

describe('realSleep', () => {
  it('ends early when aborted', async () => {
    const abort = new AbortController();
    const started = performance.now();
    const sleeping = realSleep(10_000, abort.signal);
    abort.abort();
    await sleeping;
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
