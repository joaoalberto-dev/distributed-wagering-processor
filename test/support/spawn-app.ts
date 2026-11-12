import type { Subprocess } from 'bun';
import { waitFor } from './wait-for.js';

const PROJECT_ROOT = new URL('../..', import.meta.url).pathname;

export type SpawnAppOptions = {
  /** Environment for the process, on top of `PATH` and `HOME`. */
  readonly env: Record<string, string>;
  /** The entry point; the built app by default. */
  readonly entry?: string;
  readonly startTimeoutMs?: number;
  /**
   * Whether to wait for `/health/ready` (the default). A process meant to
   * crash while it starts, such as one with `crash-after-send` and events
   * already due, is returned at once.
   */
  readonly waitUntilReady?: boolean;
};

export type SpawnedApp = {
  readonly pid: number;
  readonly baseUrl: string;
  /** Everything the process wrote so far, for assertions and failure messages. */
  output(): string;
  /** Sends `signal` and resolves with the exit code once the process is gone. */
  stop(signal?: NodeJS.Signals): Promise<number | null>;
  readonly exited: Promise<number>;
};

const running = new Set<Subprocess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

/** A port that was free a moment ago, found by binding port 0. */
export function freePort(): number {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream)
    sink.push(decoder.decode(chunk, { stream: true }));
}

/** Starts the app as a separate process and, by default, waits until `/health/ready` answers 200. */
export async function spawnApp(options: SpawnAppOptions): Promise<SpawnedApp> {
  const port = freePort();
  const chunks: string[] = [];
  const child = Bun.spawn(['bun', options.entry ?? 'dist/bootstrap/main.js'], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NO_COLOR: '1',
      ...options.env,
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  running.add(child);
  // Both streams end when the process exits; reading errors only lose output.
  const drained = Promise.all([
    collect(child.stdout, chunks),
    collect(child.stderr, chunks),
  ]).catch(() => undefined);
  const exited = child.exited.finally(() => running.delete(child));

  const baseUrl = `http://127.0.0.1:${port}`;
  const app: SpawnedApp = {
    pid: child.pid,
    baseUrl,
    output: () => chunks.join(''),
    exited,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
      await exited;
      await drained;
      return child.exitCode;
    },
  };

  if (options.waitUntilReady === false) return app;
  try {
    await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`exited with code ${child.exitCode}`);
        }
        const response = await fetch(`${baseUrl}/health/ready`);
        return response.ok;
      },
      {
        timeoutMs: options.startTimeoutMs ?? 15000,
        description: `app on port ${port}`,
      },
    );
  } catch (error) {
    await app.stop('SIGKILL');
    throw new Error(`The app did not start:\n${app.output()}`, {
      cause: error,
    });
  }
  return app;
}
