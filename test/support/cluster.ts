import { afterAll, beforeAll, expect } from 'bun:test';
import { brl, keyOf, openWalletBody, type WagerBody } from './factories.js';
import { HttpClient, type HttpResponse } from './http-client.js';
import type { Infrastructure } from './infrastructure.js';
import { type SpawnedApp, spawnApp } from './spawn-app.js';
import { waitFor } from './wait-for.js';

export type ClusterOptions = {
  /** Number of processes; the concurrency layer always runs three or more. */
  readonly size?: number;
  /** Extra environment for every process, on top of the spec's. */
  readonly env?: Record<string, string>;
};

/** Several app processes on the same database and queues, one client each. */
export type Cluster = {
  readonly apps: readonly SpawnedApp[];
  readonly clients: readonly HttpClient[];
  /** The client of process `i`, wrapping around, to spread requests across processes. */
  client(i: number): HttpClient;
};

export type Wallet = {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { amount: string; currency: string };
  readonly version: number;
};

export type WagerResult = {
  readonly transactionId: string;
  readonly status: string;
  readonly balance: { amount: string; currency: string } | null;
  readonly failureCode?: string;
  readonly idempotentReplay: boolean;
};

/** How long a client keeps resending a 503 with the same key before giving up. */
export const RETRY_UNAVAILABLE_MS = 60_000;

/**
 * Starts `size` processes before the spec's tests, asserts that their PIDs
 * are distinct (challenge §13 scenario 4), and stops them after.
 */
export function useCluster(
  infrastructure: Infrastructure,
  options: ClusterOptions = {},
): Cluster {
  const size = options.size ?? 3;
  if (size < 3)
    throw new Error('A concurrency cluster needs 3 or more processes');
  const apps: SpawnedApp[] = [];
  const clients: HttpClient[] = [];

  beforeAll(async () => {
    const env = { ...infrastructure.env, ...options.env };
    const started = await Promise.allSettled(
      Array.from({ length: size }, () => spawnApp({ env })),
    );
    for (const result of started) {
      if (result.status === 'fulfilled') apps.push(result.value);
    }
    const failed = started.find((r) => r.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    clients.push(...apps.map((app) => new HttpClient(app.baseUrl)));
    expect(new Set(apps.map((app) => app.pid)).size).toBe(size);
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.stop()));
  });

  return {
    apps,
    clients,
    client: (i) => {
      const client = clients[i % clients.length];
      if (client === undefined)
        throw new Error('Cluster is used before beforeAll');
      return client;
    },
  };
}

/** Opens a BRL wallet through `client` and returns it. */
export async function openWallet(
  client: HttpClient,
  amount: string,
): Promise<Wallet> {
  const response = await client.post<Wallet>(
    '/wallets',
    openWalletBody(brl(amount)),
    { retryUnavailableMs: RETRY_UNAVAILABLE_MS },
  );
  expect(response.status).toBe(201);
  return response.body;
}

/** Submits `body` under its recommended key, resending a 503 with the same key. */
export function submit(
  client: HttpClient,
  body: WagerBody,
): Promise<HttpResponse<WagerResult>> {
  return client.post<WagerResult>('/wagering/transactions', body, {
    headers: keyOf(body),
    retryUnavailableMs: RETRY_UNAVAILABLE_MS,
  });
}

export async function walletOf(
  client: HttpClient,
  walletId: string,
): Promise<Wallet> {
  const response = await client.get<Wallet>(`/wallets/${walletId}`, {
    retryUnavailableMs: RETRY_UNAVAILABLE_MS,
  });
  expect(response.status).toBe(200);
  return response.body;
}

/** Every ledger entry's direction for `walletId`, oldest first. */
export async function ledgerDirections(
  client: HttpClient,
  walletId: string,
): Promise<string[]> {
  const directions: string[] = [];
  let cursor: string | null = null;
  do {
    const query: string =
      cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const response: HttpResponse<{
      items: { direction: string }[];
      nextCursor: string | null;
    }> = await client.get(`/wallets/${walletId}/ledger?limit=100${query}`, {
      retryUnavailableMs: RETRY_UNAVAILABLE_MS,
    });
    expect(response.status).toBe(200);
    directions.push(...response.body.items.map((i) => i.direction));
    cursor = response.body.nextCursor;
  } while (cursor !== null);
  return directions;
}

/** The value of one sample in a process's `/metrics`, 0 when absent. */
export async function metricValue(
  client: HttpClient,
  sample: string,
): Promise<number> {
  const response = await client.get<string>('/metrics', {
    retryUnavailableMs: RETRY_UNAVAILABLE_MS,
  });
  expect(response.status).toBe(200);
  const line = response.body
    .split('\n')
    .find((l) => l.startsWith(`${sample} `));
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

/** A transaction resource, as the query routes answer it. */
export type StoredTransaction = {
  readonly id: string;
  readonly status: string;
  readonly failureCode?: string;
  readonly referenceTransactionId?: string;
};

/**
 * Waits until `body`'s operation is stored, for one sent over SQS, and
 * until `ready` accepts it (by default any status but `PENDING_REFERENCE`).
 */
export function storedOf(
  client: HttpClient,
  body: WagerBody,
  ready: (transaction: StoredTransaction) => boolean = (t) =>
    t.status !== 'PENDING_REFERENCE',
  timeoutMs = 60_000,
): Promise<StoredTransaction> {
  return waitFor(
    async () => {
      const response = await client.get<StoredTransaction>(
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
        { retryUnavailableMs: RETRY_UNAVAILABLE_MS },
      );
      return response.status === 200 && ready(response.body)
        ? response.body
        : undefined;
    },
    {
      timeoutMs,
      intervalMs: 100,
      description: `${body.externalTransactionId} to be stored`,
    },
  );
}
