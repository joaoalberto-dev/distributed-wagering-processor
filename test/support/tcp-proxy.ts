import type { Socket, TCPSocketListener } from 'bun';
import { afterAll, beforeAll } from 'bun:test';

type Side = {
  /** Bytes the socket could not take yet; written on `drain`. */
  pending: Uint8Array[];
  peer: Socket<Side> | undefined;
  /** Bytes from the client while the upstream connection is still opening. */
  early: Uint8Array[];
};

/**
 * A TCP proxy between spawned processes and a shared container (§19,
 * Outages). `cut()` closes every current connection and refuses new ones;
 * `restore()` lets them through again. The containers themselves are never
 * stopped, so other specs keep using them.
 */
export class TcpProxy {
  readonly #sockets = new Set<Socket<Side>>();
  #listener: TCPSocketListener<Side> | undefined;
  #upstream: { hostname: string; port: number } | undefined;
  #cut = false;

  /** `upstreamUrl` is read at `start`, once the spec's environment exists. */
  constructor(private readonly upstreamUrl: () => string) {}

  get port(): number {
    if (this.#listener === undefined)
      throw new Error('the proxy is not started');
    return this.#listener.port;
  }

  /** `url` with its host and port replaced by the proxy's. */
  rewrite(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = '127.0.0.1';
    parsed.port = String(this.port);
    return parsed.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
  }

  get isCut(): boolean {
    return this.#cut;
  }

  start(): void {
    if (this.#listener !== undefined) return;
    const upstream = new URL(this.upstreamUrl());
    this.#upstream = {
      hostname: upstream.hostname,
      port: Number(
        upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      ),
    };
    this.#listener = Bun.listen<Side>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: (client) => this.#accept(client),
        data: (client, data) => {
          const upstream = client.data.peer;
          if (upstream === undefined) client.data.early.push(copy(data));
          else send(upstream, data);
        },
        drain: (client) => flush(client),
        close: (client) => this.#closed(client),
        error: (client) => this.#closed(client),
      },
    });
  }

  /** Closes every connection through the proxy and refuses new ones. */
  cut(): void {
    this.#cut = true;
    const sockets = Array.from(this.#sockets);
    this.#sockets.clear();
    for (const socket of sockets) socket.terminate();
  }

  restore(): void {
    this.#cut = false;
  }

  stop(): void {
    this.cut();
    this.#listener?.stop(true);
    this.#listener = undefined;
  }

  #accept(client: Socket<Side>): void {
    client.data = { pending: [], peer: undefined, early: [] };
    if (this.#cut) {
      client.terminate();
      return;
    }
    this.#sockets.add(client);
    const refused = () => {
      this.#sockets.delete(client);
      client.terminate();
    };
    Bun.connect<Side>({
      ...(this.#upstream as { hostname: string; port: number }),
      data: { pending: [], peer: client, early: [] },
      socket: {
        open: (upstream) => {
          // The client left, or a cut came, while this connection was opening.
          if (this.#cut || !this.#sockets.has(client)) {
            upstream.terminate();
            return;
          }
          this.#sockets.add(upstream);
          client.data.peer = upstream;
          for (const chunk of client.data.early) send(upstream, chunk);
          client.data.early = [];
        },
        data: (_upstream, data) => send(client, data),
        drain: (upstream) => flush(upstream),
        close: (upstream) => this.#closed(upstream),
        error: (upstream) => this.#closed(upstream),
        connectError: refused,
      },
    }).catch(refused);
  }

  /** One side went away: the other side goes too. */
  #closed(socket: Socket<Side>): void {
    this.#sockets.delete(socket);
    const peer = socket.data?.peer;
    if (peer !== undefined && this.#sockets.has(peer)) {
      this.#sockets.delete(peer);
      peer.end();
    }
  }
}

function copy(data: Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

/** Writes in order: anything already waiting goes first. */
function send(socket: Socket<Side>, data: Uint8Array): void {
  if (socket.data.pending.length > 0) {
    socket.data.pending.push(copy(data));
    return;
  }
  const written = socket.write(data);
  if (written < data.byteLength) {
    socket.data.pending.push(copy(data.subarray(Math.max(written, 0))));
  }
}

function flush(socket: Socket<Side>): void {
  const queue = socket.data.pending;
  while (queue.length > 0) {
    const chunk = queue[0] as Uint8Array;
    const written = socket.write(chunk);
    if (written < chunk.byteLength) {
      queue[0] = chunk.subarray(Math.max(written, 0));
      return;
    }
    queue.shift();
  }
}

/** A proxy to `upstreamUrl()`, started before the spec's tests and stopped after them. */
export function useTcpProxy(upstreamUrl: () => string): TcpProxy {
  const proxy = new TcpProxy(upstreamUrl);
  beforeAll(() => proxy.start());
  afterAll(() => proxy.stop());
  return proxy;
}
