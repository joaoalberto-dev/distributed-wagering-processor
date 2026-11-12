/**
 * The wallet routes over HTTP against a spawned process: opening, reading,
 * the ledger pages, and the error contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendWins, type Row, useDatabase } from '../support/database.js';
import { brl, openWalletBody, playerId } from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';

const infrastructure = useInfrastructure('wallets-http');
const database = useDatabase(infrastructure);

let app: SpawnedApp;
let http: HttpClient;

beforeAll(async () => {
  app = await spawnApp({ env: infrastructure.env });
  http = new HttpClient(app.baseUrl);
});

afterAll(async () => {
  await app.stop();
});

type Wallet = {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
};
type LedgerItem = {
  id: string;
  transactionId: string;
  direction: string;
  amount: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  walletVersion: number;
  createdAt: string;
};
type LedgerPage = { items: LedgerItem[]; nextCursor: string | null };
type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

async function open(body = openWalletBody()): Promise<Wallet> {
  const response = await http.post<Wallet>('/wallets', body);
  expect(response.status).toBe(201);
  return response.body;
}

const UNKNOWN = '0192f291-27dd-7d3f-8071-5f8685deef37';

describe('POST /wallets', () => {
  it('opens at 0.00 with version 1 and no ledger entry or transaction', async () => {
    const body = openWalletBody(brl('0.00'));
    const wallet = await open(body);
    expect(wallet).toEqual({
      id: wallet.id,
      playerId: body.playerId,
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(wallet.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);

    const ledger = await http.get<LedgerPage>(`/wallets/${wallet.id}/ledger`);
    expect(ledger.body).toEqual({ items: [], nextCursor: null });
    const rows = (await database.owner`
      SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${wallet.id}`) as Row[];
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('records a positive opening as one OPENING CREDIT at version 1', async () => {
    const wallet = await open(openWalletBody(brl('100.00')));
    expect(wallet.balance).toEqual(brl('100.00'));
    expect(wallet.version).toBe(1);

    const ledger = await http.get<LedgerPage>(`/wallets/${wallet.id}/ledger`);
    expect(ledger.body.nextCursor).toBeNull();
    expect(ledger.body.items).toEqual([
      {
        id: expect.any(String) as string,
        transactionId: expect.any(String) as string,
        direction: 'CREDIT',
        amount: brl('100.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('100.00'),
        walletVersion: 1,
        createdAt: expect.any(String) as string,
      },
    ]);
    const [opening] = (await database.owner`
      SELECT kind, status, provider_id FROM wager_transactions WHERE wallet_id = ${wallet.id}`) as Row[];
    expect(opening).toEqual({
      kind: 'OPENING',
      status: 'PROCESSED',
      provider_id: null,
    });
    const events = (await database.owner`
      SELECT event_type FROM outbox WHERE wallet_id = ${wallet.id} ORDER BY event_type`) as {
      event_type: string;
    }[];
    expect(events.map((e) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('refuses a second wallet for the same player and currency with 409 and the existing ID', async () => {
    const player = playerId();
    const first = await open(openWalletBody(brl('10.00'), player));
    const second = await http.post<ErrorBody>(
      '/wallets',
      openWalletBody(brl('0.00'), player),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    expect(second.body.error.details).toEqual({ walletId: first.id });

    const usd = await http.post<Wallet>(
      '/wallets',
      openWalletBody({ amount: '1.00', currency: 'USD' }, player),
    );
    expect(usd.status).toBe(201);
  });

  it('opens exactly one wallet when the same player opens concurrently', async () => {
    const player = playerId();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        http.post<Wallet | ErrorBody>(
          '/wallets',
          openWalletBody(brl('5.00'), player),
          { retryUnavailableMs: 10_000 },
        ),
      ),
    );
    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    const walletId = (created[0]?.body as Wallet | undefined)?.id;
    for (const response of responses.filter((r) => r.status !== 201)) {
      expect(response.status).toBe(409);
      expect((response.body as ErrorBody).error.details).toEqual({ walletId });
    }
  });

  it('answers an invalid body with 400 VALIDATION_FAILED and the issues', async () => {
    const response = await http.post<ErrorBody>('/wallets', {
      playerId: 'not-a-uuid',
      initialBalance: { amount: '-1.00', currency: 'BRL' },
      extra: true,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    const issues = (response.body.error.details?.issues ?? []) as {
      path: string;
    }[];
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('playerId');
    expect(paths).toContain('initialBalance.amount');

    const malformed = await http.post<ErrorBody>('/wallets', '{"playerId":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the wallet', async () => {
    const wallet = await open();
    const response = await http.get<Wallet>(`/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(wallet);
  });

  it('answers unknown IDs with 404 on every wallet route and malformed IDs with 400', async () => {
    for (const response of [
      await http.get<ErrorBody>(`/wallets/${UNKNOWN}`),
      await http.get<ErrorBody>(`/wallets/${UNKNOWN}/ledger`),
      await http.post<ErrorBody>(`/wallets/${UNKNOWN}/reconciliation`),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    }
    const malformed = await http.get<ErrorBody>('/wallets/WALLET-1');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.details?.issues).toEqual([
      { path: 'walletId', message: 'must be a lowercase UUID' },
    ]);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages 120 entries by 50 as 50, 50, and 20, ascending, then a null cursor', async () => {
    const wallet = await open(openWalletBody(brl('1000.00')));
    await appendWins(database.app, wallet.id, 119);

    const sizes: number[] = [];
    const versions: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null ? '?limit=50' : `?limit=50&cursor=${cursor}`;
      const page = await http.get<LedgerPage>(
        `/wallets/${wallet.id}/ledger${query}`,
      );
      expect(page.status).toBe(200);
      sizes.push(page.body.items.length);
      versions.push(...page.body.items.map((item) => item.walletVersion));
      cursor = page.body.nextCursor;
    } while (cursor !== null);

    expect(sizes).toEqual([50, 50, 20]);
    expect(versions).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  it('defaults the limit to 50', async () => {
    const wallet = await open(openWalletBody(brl('1000.00')));
    await appendWins(database.app, wallet.id, 59);
    const page = await http.get<LedgerPage>(`/wallets/${wallet.id}/ledger`);
    expect(page.body.items).toHaveLength(50);
    expect(page.body.nextCursor).not.toBeNull();
  });

  it('answers limit=500 with 400 VALIDATION_FAILED and a garbage cursor with 400 INVALID_CURSOR', async () => {
    const wallet = await open();
    const tooMany = await http.get<ErrorBody>(
      `/wallets/${wallet.id}/ledger?limit=500`,
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('VALIDATION_FAILED');

    const garbage = await http.get<ErrorBody>(
      `/wallets/${wallet.id}/ledger?cursor=garbage`,
    );
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('INVALID_CURSOR');
  });
});
