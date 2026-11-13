/**
 * Two pending-reference workers on the same due row, with the interleaving
 * forced instead of left to timing: worker A takes the wallet lock, and
 * worker B runs its whole cycle before A goes on. Two in-process
 * applications, each with its own pool, stand for two instances.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type {
  TxContext,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work.js';
import {
  REFERENCE_WORKER_DEFAULTS,
  ResolvePendingReferences,
} from '../../src/application/wagering/resolve-pending-references.js';
import type { Application } from '../../src/bootstrap/container.js';
import { Money } from '../../src/domain/money/money.js';
import { NestAppLogger } from '../../src/infrastructure/observability/json-logger.js';
import { type Row, useDatabase } from '../support/database.js';
import { externalId, playerId } from '../support/factories.js';
import { startInProcess } from '../support/in-process.js';
import { useInfrastructure } from '../support/infrastructure.js';

const infrastructure = useInfrastructure('worker-race');
const database = useDatabase(infrastructure);

let first: Application;
let second: Application;

beforeAll(async () => {
  [first, second] = await Promise.all([
    startInProcess(infrastructure),
    startInProcess(infrastructure),
  ]);
});

afterAll(async () => {
  await Promise.all([first.close(), second.close()]);
});

/** Restrict selection to this spec's row in the shared test database. */
function selectOnly(unitOfWork: UnitOfWork, id: string): UnitOfWork {
  return {
    run: (fn, options) =>
      unitOfWork.run(
        (tx) =>
          fn({
            ...tx,
            transactions: new Proxy(tx.transactions, {
              get(target, property, receiver) {
                if (property === 'selectDue') {
                  return async () =>
                    (await target.recheck(id))?.due ? [id] : [];
                }
                const value: unknown = Reflect.get(target, property, receiver);
                return typeof value === 'function'
                  ? ((value as (...a: unknown[]) => unknown).bind(
                      target,
                    ) as unknown)
                  : value;
              },
            }),
          }),
        options,
      ),
  };
}

/**
 * `unitOfWork`, with `during` run once right after the first successful lock
 * of `walletId`, while that lock is held.
 */
function pausingAfterLock(
  unitOfWork: UnitOfWork,
  walletId: string,
  during: () => Promise<void>,
): UnitOfWork {
  let armed = true;
  const wrap = (tx: TxContext): TxContext => ({
    ...tx,
    wallets: new Proxy(tx.wallets, {
      get(target, property, receiver) {
        if (property === 'lock') {
          return async (...args: Parameters<TxContext['wallets']['lock']>) => {
            const wallet = await target.lock(...args);
            if (armed && args[0] === walletId && wallet !== null) {
              armed = false;
              await during();
            }
            return wallet;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? ((value as (...a: unknown[]) => unknown).bind(target) as unknown)
          : value;
      },
    }),
  });
  return {
    run: (fn, options) => unitOfWork.run((tx) => fn(wrap(tx)), options),
  };
}

/** A `REFUND` whose `BET` never arrives, made due before either cycle. */
async function duePendingRefund(): Promise<{ id: string; walletId: string }> {
  const player = playerId();
  const wallet = await first.openWallet.execute({
    playerId: player,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    correlationId: 'worker-race',
  });
  const operation = {
    providerId: 'provider-a',
    externalTransactionId: externalId('refund'),
    playerId: player,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'REFUND' as const,
    money: { amount: '25.00', currency: 'BRL' },
    referenceExternalTransactionId: externalId('bet'),
  };
  const result = await first.submitWagerTransaction.execute({
    operation,
    idempotencyKey: `${operation.providerId}:${operation.externalTransactionId}`,
    channel: 'http',
    correlationId: 'worker-race',
    causationId: 'worker-race',
  });
  expect(result.transaction.status).toBe('PENDING_REFERENCE');
  const id = result.transaction.id;
  await database.owner`
    UPDATE wager_transactions
       SET next_reference_attempt_at = clock_timestamp() - interval '1 second'
     WHERE id = ${id}`;
  return { id, walletId: wallet.id };
}

async function schedule(id: string): Promise<Row> {
  const [row] = (await database.owner`
    SELECT attempts, status FROM wager_transactions WHERE id = ${id}`) as Row[];
  if (row === undefined) throw new Error(`no transaction ${id}`);
  return row;
}

function worker(app: Application, unitOfWork: UnitOfWork) {
  return new ResolvePendingReferences(
    unitOfWork,
    app.clock,
    app.ids,
    app.metrics,
    new NestAppLogger(app.logger, 'WorkerRace'),
    app.requestContext,
    {
      ...REFERENCE_WORKER_DEFAULTS,
      referenceTtlMs: app.config.referenceTtlSeconds * 1000,
    },
  );
}

describe('two workers on one due row', () => {
  it('count the attempt of the worker holding the wallet lock, whatever the other one does meanwhile', async () => {
    const { id, walletId } = await duePendingRefund();
    const contender = worker(second, selectOnly(second.unitOfWork, id));
    let secondSelected = -1;
    const holder = worker(
      first,
      pausingAfterLock(selectOnly(first.unitOfWork, id), walletId, async () => {
        secondSelected = await contender.runCycle();
      }),
    );

    expect(await holder.runCycle()).toBe(1);

    // The other worker saw the row due while the wallet was locked.
    expect(secondSelected).toBe(1);
    // Only the lock holder counts an attempt.
    expect(await schedule(id)).toEqual({
      attempts: 1,
      status: 'PENDING_REFERENCE',
    });
  });
});
