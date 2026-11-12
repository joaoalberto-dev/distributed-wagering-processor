/**
 * Reversals over HTTP against a spawned process: one successful reversal per
 * transaction, `ROLLBACK` as the inverse of its reference's entry, reversal
 * funds, and a settlement against a reversed `BET` in both arrival orders.
 *
 * The spawned process runs no worker, so a dependent waits until the spec
 * runs one worker cycle in process: the arrival order is then exact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Application } from '../../src/bootstrap/container.js';
import {
  brl,
  externalId,
  keyOf,
  type MoneyBody,
  openWalletBody,
  type WagerBody,
  wagerBody,
} from '../support/factories.js';
import { HttpClient } from '../support/http-client.js';
import { startInProcess } from '../support/in-process.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { expectReconciled } from '../support/reconcile.js';
import { type SpawnedApp, spawnApp } from '../support/spawn-app.js';
import { waitFor } from '../support/wait-for.js';

const infrastructure = useInfrastructure('reversals');

let app: SpawnedApp;
let http: HttpClient;
let worker: Application;
const opened: string[] = [];

beforeAll(async () => {
  app = await spawnApp({
    env: { ...infrastructure.env, REFERENCE_WORKER_ENABLED: 'false' },
  });
  http = new HttpClient(app.baseUrl);
  worker = await startInProcess(infrastructure);
});

afterAll(async () => {
  await expectReconciled(http, opened);
  await worker.close();
  await app.stop();
});

type Wallet = { id: string; playerId: string; balance: MoneyBody };
type Result = {
  transactionId: string;
  status: string;
  balance: MoneyBody | null;
  failureCode?: string;
  details?: Record<string, unknown>;
};
type Resource = {
  id: string;
  status: string;
  referenceTransactionId?: string;
  details?: Record<string, unknown>;
};

async function open(amount = '100.00'): Promise<Wallet> {
  const response = await http.post<Wallet>(
    '/wallets',
    openWalletBody(brl(amount)),
  );
  expect(response.status).toBe(201);
  opened.push(response.body.id);
  return response.body;
}

async function send(body: WagerBody, expectedStatus: number): Promise<Result> {
  const response = await http.post<Result>('/wagering/transactions', body, {
    headers: keyOf(body),
  });
  expect({ status: response.status, body: response.body }).toMatchObject({
    status: expectedStatus,
  });
  return response.body;
}

function reversal(
  wallet: Wallet,
  kind: 'REFUND' | 'ROLLBACK',
  of: WagerBody,
): WagerBody {
  return wagerBody(wallet, {
    kind,
    money: of.money,
    referenceExternalTransactionId: of.externalTransactionId,
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const response = await http.get<Wallet>(`/wallets/${walletId}`);
  return response.body.balance.amount;
}

/** Runs worker cycles in process until the transaction is decided. */
async function resolved(transactionId: string): Promise<Resource> {
  return waitFor(
    async () => {
      await worker.resolvePendingReferences.runCycle();
      const response = await http.get<Resource>(
        `/wagering/transactions/${transactionId}`,
      );
      return response.body.status === 'PENDING_REFERENCE'
        ? undefined
        : response.body;
    },
    { timeoutMs: 10_000, intervalMs: 100, description: 'a worker decision' },
  );
}

describe('one successful reversal per transaction', () => {
  it('rejects a ROLLBACK of a BET already refunded, naming the refund', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    await send(bet, 200);
    const refund = await send(reversal(wallet, 'REFUND', bet), 200);
    expect(refund.balance).toEqual(brl('100.00'));

    const rollback = await send(reversal(wallet, 'ROLLBACK', bet), 422);

    expect(rollback).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      details: { referenceReversedBy: refund.transactionId },
      balance: brl('100.00'),
    });
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('rejects a second REFUND of the same BET', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    await send(bet, 200);
    await send(reversal(wallet, 'REFUND', bet), 200);

    const second = await send(reversal(wallet, 'REFUND', bet), 422);

    expect(second.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('ROLLBACK', () => {
  it('debits the credit of a WIN', async () => {
    const wallet = await open();
    const win = wagerBody(wallet, { kind: 'WIN', money: brl('40.00') });
    await send(win, 200);

    const rollback = await send(reversal(wallet, 'ROLLBACK', win), 200);

    expect(rollback).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
    });
  });

  it('debits the credit of a REFUND, so the BET stands again', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    await send(bet, 200);
    const refund = reversal(wallet, 'REFUND', bet);
    await send(refund, 200);

    const rollback = await send(reversal(wallet, 'ROLLBACK', refund), 200);

    expect(rollback.balance).toEqual(brl('75.00'));
  });

  it('rejects a debit beyond the balance as REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await open();
    const win = wagerBody(wallet, { kind: 'WIN', money: brl('50.00') });
    await send(win, 200);
    await send(wagerBody(wallet, { money: brl('140.00') }), 200);

    const rollback = await send(reversal(wallet, 'ROLLBACK', win), 422);

    expect(rollback).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
    });
    expect(await balanceOf(wallet.id)).toBe('10.00');
  });
});

describe('a WIN against a reversed BET', () => {
  it('is processed and flagged when the reversal arrives first', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet);
    await send(bet, 200);
    const refund = await send(reversal(wallet, 'REFUND', bet), 200);

    const win = await send(
      wagerBody(wallet, {
        kind: 'WIN',
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      200,
    );

    expect(win).toMatchObject({
      status: 'PROCESSED',
      balance: brl('130.00'),
      details: { referenceReversedBy: refund.transactionId },
    });
  });

  it('is processed and flagged when the WIN arrives first and waits for its BET', async () => {
    const wallet = await open();
    const bet = wagerBody(wallet, { externalTransactionId: externalId('bet') });
    const win = await send(
      wagerBody(wallet, {
        kind: 'WIN',
        money: brl('30.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      202,
    );
    await send(bet, 200);
    const refund = await send(reversal(wallet, 'REFUND', bet), 200);

    const decided = await resolved(win.transactionId);

    expect(decided).toMatchObject({
      status: 'PROCESSED',
      details: { referenceReversedBy: refund.transactionId },
    });
    expect(await balanceOf(wallet.id)).toBe('130.00');
  });
});
