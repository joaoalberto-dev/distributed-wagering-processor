/**
 * `POST /wagering/transactions` and the two transaction reads against a
 * spawned process: each kind, the §8 decision table, the status by stored
 * state, the error contract, and a full HTTP bulkhead (CUJ 1 over HTTP).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Row, useDatabase } from '../support/database.js';
import {
  brl,
  externalId,
  keyOf,
  type MoneyBody,
  openWalletBody,
  playerId,
  type WagerBody,
  wagerBody,
} from '../support/factories.js';
import { HttpClient, type HttpResponse } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('wagering-http');
const database = useDatabase(infrastructure);

let app: SpawnedApp;
let http: HttpClient;
const opened: string[] = [];

beforeAll(async () => {
  app = await spawnApp({ env: infrastructure.env });
  http = new HttpClient(app.baseUrl);
});

afterAll(async () => {
  await expectReconciled(http, opened);
  await app.stop();
});

type Wallet = {
  id: string;
  playerId: string;
  balance: MoneyBody;
  version: number;
};
type Result = {
  transactionId: string;
  status: string;
  balance: MoneyBody | null;
  failureCode?: string;
  details?: Record<string, unknown>;
  idempotentReplay: boolean;
};
type Resource = Record<string, unknown> & { id: string; status: string };
type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

async function open(amount = '100.00', client = http): Promise<Wallet> {
  const response = await client.post<Wallet>(
    '/wallets',
    openWalletBody(brl(amount)),
  );
  expect(response.status).toBe(201);
  opened.push(response.body.id);
  return response.body;
}

function send(body: WagerBody, headers = keyOf(body), client = http) {
  return client.post<Result>('/wagering/transactions', body, { headers });
}

async function expectResult(
  body: WagerBody,
  status: number,
  expected: Partial<Result>,
): Promise<Result> {
  const response = await send(body);
  expect({ status: response.status, body: response.body }).toMatchObject({
    status,
    body: { idempotentReplay: false, ...expected },
  });
  return response.body;
}

async function balanceOf(walletId: string): Promise<string> {
  const response = await http.get<Wallet>(`/wallets/${walletId}`);
  return response.body.balance.amount;
}

async function rowsFor(externalTransactionId: string): Promise<number> {
  const [row] = (await database.owner`
    SELECT count(*)::int AS n FROM wager_transactions
     WHERE external_transaction_id = ${externalTransactionId}`) as Row[];
  return row?.n as number;
}

describe('each kind', () => {
  it('BET debits, WIN credits, LOSS changes nothing, REFUND and ROLLBACK reverse a BET', async () => {
    const wallet = await open('100.00');
    const bet = wagerBody(wallet);
    await expectResult(bet, 200, {
      status: 'PROCESSED',
      balance: brl('75.00'),
    });

    await expectResult(
      wagerBody(wallet, { kind: 'WIN', money: brl('10.00') }),
      200,
      {
        status: 'PROCESSED',
        balance: brl('85.00'),
      },
    );
    const settled = await expectResult(
      wagerBody(wallet, {
        kind: 'WIN',
        money: brl('5.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      200,
      { status: 'PROCESSED', balance: brl('90.00') },
    );
    const version = (await http.get<Wallet>(`/wallets/${wallet.id}`)).body
      .version;
    await expectResult(
      wagerBody(wallet, {
        kind: 'LOSS',
        money: brl('0.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      200,
      { status: 'PROCESSED', balance: brl('90.00') },
    );
    expect((await http.get<Wallet>(`/wallets/${wallet.id}`)).body.version).toBe(
      version,
    );

    await expectResult(
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      200,
      { status: 'PROCESSED', balance: brl('115.00') },
    );
    expect(await balanceOf(wallet.id)).toBe('115.00');

    const resource = await http.get<Resource>(
      `/wagering/transactions/${settled.transactionId}`,
    );
    expect(resource.body.referenceExternalTransactionId).toBe(
      bet.externalTransactionId,
    );
    expect(resource.body.referenceTransactionId).toEqual(expect.any(String));
  });

  it('ROLLBACK of a BET credits its amount back', async () => {
    const wallet = await open('50.00');
    const bet = wagerBody(wallet, { money: brl('20.00') });
    await expectResult(bet, 200, { balance: brl('30.00') });
    await expectResult(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        money: brl('20.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      200,
      { status: 'PROCESSED', balance: brl('50.00') },
    );
    const ledger = await http.get<{ items: { direction: string }[] }>(
      `/wallets/${wallet.id}/ledger`,
    );
    expect(ledger.body.items.map((i) => i.direction)).toEqual([
      'CREDIT',
      'DEBIT',
      'CREDIT',
    ]);
  });
});

describe('the §8 decision table', () => {
  it('replays the same key and payload with the same result and no second effect', async () => {
    const wallet = await open('100.00');
    const bet = wagerBody(wallet);
    const first = await expectResult(bet, 200, { status: 'PROCESSED' });
    const replay = await send(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first, idempotentReplay: true });
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await rowsFor(bet.externalTransactionId)).toBe(1);
  });

  it('answers the same key with another payload with 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    await expectResult(bet, 200, {});
    const conflict = await http.post<ErrorBody>(
      '/wagering/transactions',
      { ...bet, money: brl('26.00') },
      { headers: keyOf(bet) },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('answers a stored external ID under a new key with 409 EXTERNAL_TRANSACTION_ID_CONFLICT, even for the same payload', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    await expectResult(bet, 200, {});
    const conflict = await http.post<ErrorBody>('/wagering/transactions', bet, {
      headers: { 'idempotency-key': externalId('another-key') },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
    expect(await balanceOf(wallet.id)).toBe('75.00');
  });

  it('replays a rejection as 422 with the same body', async () => {
    const wallet = await open('10.00');
    const bet = wagerBody(wallet);
    const first = await expectResult(bet, 422, {
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
    });
    const replay = await send(bet);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first, idempotentReplay: true });
  });
});

describe('a pending reference', () => {
  it('answers 202 with Location, replays 202, and reads back as PENDING_REFERENCE', async () => {
    const wallet = await open();
    const refund = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: externalId('not-yet'),
    });
    const response = await send(refund);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: null,
      idempotentReplay: false,
    });
    const location = response.headers.get('location');
    expect(location).toBe(
      `/wagering/transactions/${response.body.transactionId}`,
    );

    const replay = await send(refund);
    expect(replay.status).toBe(202);
    expect(replay.headers.get('location')).toBe(location);
    expect(replay.body.idempotentReplay).toBe(true);

    const resource = await http.get<Resource>(location ?? '');
    expect(resource.status).toBe(200);
    expect(resource.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      resultBalance: null,
      attempts: 0,
    });
  });
});

describe('domain rejections without references', () => {
  it('answers each with 422 and persists it', async () => {
    const wallet = await open('10.00');
    const cases: [Partial<WagerBody>, string][] = [
      [{ money: brl('10.01') }, 'INSUFFICIENT_FUNDS'],
      [{ playerId: playerId() }, 'WALLET_PLAYER_MISMATCH'],
      [{ money: { amount: '1.00', currency: 'USD' } }, 'CURRENCY_MISMATCH'],
    ];
    for (const [overrides, failureCode] of cases) {
      const body = wagerBody(wallet, overrides);
      await expectResult(body, 422, {
        status: 'REJECTED',
        failureCode,
        balance: brl('10.00'),
      });
      expect(await rowsFor(body.externalTransactionId)).toBe(1);
    }

    const full = await open('999999999999.99');
    await expectResult(
      wagerBody(full, { kind: 'WIN', money: brl('0.01') }),
      422,
      {
        status: 'REJECTED',
        failureCode: 'BALANCE_LIMIT_EXCEEDED',
        balance: brl('999999999999.99'),
      },
    );
  });
});

describe('errors', () => {
  it('answers a missing Idempotency-Key with 400 VALIDATION_FAILED', async () => {
    const wallet = await open();
    const response = await http.post<ErrorBody>(
      '/wagering/transactions',
      wagerBody(wallet),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const issues = response.body.error.details?.issues as { path: string }[];
    expect(issues.map((i) => i.path)).toEqual(['idempotency-key']);
  });

  it('answers a body that breaks the contract with 400 and stores nothing', async () => {
    const wallet = await open();
    const body = wagerBody(wallet, { kind: 'REFUND' });
    const response = await http.post<ErrorBody>(
      '/wagering/transactions',
      { ...body, extra: true },
      { headers: keyOf(body) },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(await rowsFor(body.externalTransactionId)).toBe(0);
  });

  it('answers an unknown wallet with 404 WALLET_NOT_FOUND and stores nothing', async () => {
    const body = wagerBody({ id: Bun.randomUUIDv7(), playerId: playerId() });
    const response = await http.post<ErrorBody>(
      '/wagering/transactions',
      body,
      {
        headers: keyOf(body),
      },
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    expect(await rowsFor(body.externalTransactionId)).toBe(0);
  });
});

describe('the transaction reads', () => {
  it('return the resource by ID and by provider and external ID', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    const result = await expectResult(bet, 200, {});
    const byId = await http.get<Resource>(
      `/wagering/transactions/${result.transactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      id: result.transactionId,
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: bet.roundId,
      gameId: bet.gameId,
      kind: 'BET',
      money: brl('25.00'),
      status: 'PROCESSED',
      resultBalance: brl('75.00'),
      attempts: 0,
      createdAt: expect.any(String) as string,
      processedAt: expect.any(String) as string,
    });
    const byExternalId = await http.get<Resource>(
      `/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`,
    );
    expect(byExternalId.body).toEqual(byId.body);
  });

  it('answer unknown transactions with 404 TRANSACTION_NOT_FOUND', async () => {
    for (const response of [
      await http.get<ErrorBody>(`/wagering/transactions/${Bun.randomUUIDv7()}`),
      await http.get<ErrorBody>(
        `/providers/provider-a/wagering/transactions/${externalId()}`,
      ),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('TRANSACTION_NOT_FOUND');
    }
  });
});

describe('a full HTTP bulkhead', () => {
  let narrow: SpawnedApp;
  let client: HttpClient;

  beforeAll(async () => {
    narrow = await spawnApp({
      env: {
        ...infrastructure.env,
        HTTP_BULKHEAD_SIZE: '1',
        HTTP_BULKHEAD_QUEUE: '0',
        DB_LOCK_TIMEOUT_MS: '8000',
      },
    });
    client = new HttpClient(narrow.baseUrl);
  });

  afterAll(async () => {
    await narrow.stop();
  });

  it('answers a second request with 503 and Retry-After: 1 while the first waits on the wallet lock', async () => {
    const wallet = await open('100.00', client);
    const held: { first?: Promise<HttpResponse<Result>> } = {};
    await database.owner.begin(async (tx) => {
      await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;
      held.first = send(wagerBody(wallet), undefined, client);
      await waitFor(
        async () => {
          const [row] = (await database.owner`
            SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`) as Row[];
          return (row?.n as number) > 0 ? true : undefined;
        },
        {
          timeoutMs: 5000,
          intervalMs: 20,
          description: 'the first request to wait on the lock',
        },
      );

      const second = await client.post<ErrorBody>(
        '/wagering/transactions',
        wagerBody(wallet),
        { headers: { 'idempotency-key': externalId('k') } },
      );
      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBe('1');
      expect(second.body.error.code).toBe('SERVICE_UNAVAILABLE');
    });
    const first = await held.first;
    expect(first?.status).toBe(200);
    expect(first?.body.balance).toEqual(brl('75.00'));
  });
});
