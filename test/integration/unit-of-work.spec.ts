/**
 * The unit of work: transaction-local timeouts, all-or-nothing writes, and
 * classified errors, against the real test database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ContentionError } from '../../src/application/errors.js';
import type { TxContext } from '../../src/application/ports/unit-of-work.js';
import type { Application } from '../../src/bootstrap/container.js';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.js';
import { Money } from '../../src/domain/money/money.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import type { MikroOrmTxContext } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.js';
import {
  insertRow,
  newId,
  openWallet,
  pendingRow,
  useDatabase,
  walletRow,
} from '../support/database.js';
import { startInProcess } from '../support/in-process.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { rejectionOf } from '../support/rejection-of.js';

const infrastructure = useInfrastructure('unit-of-work');
const database = useDatabase(infrastructure);

let app: Application;

beforeAll(async () => {
  app = await startInProcess(infrastructure);
});

afterAll(async () => {
  await app.close();
});

/** Runs SQL on the unit of work's own connection; infrastructure tests only. */
async function sqlIn<T extends object>(tx: TxContext, sql: string): Promise<T> {
  const [row] = await (tx as MikroOrmTxContext).em.execute<T[]>(sql);
  if (row === undefined) throw new Error(`no row from ${sql}`);
  return row;
}

type Settings = {
  lock_timeout: string;
  transaction_timeout: string;
  statement_timeout: string;
  transaction_isolation: string;
  transaction_read_only: string;
};

const SETTINGS = `SELECT current_setting('lock_timeout') AS lock_timeout,
  current_setting('transaction_timeout') AS transaction_timeout,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('transaction_isolation') AS transaction_isolation,
  current_setting('transaction_read_only') AS transaction_read_only`;

describe('timeouts', () => {
  it('sets the lock and transaction timeouts for a write transaction only', async () => {
    const inside = await app.unitOfWork.run(
      (tx) => sqlIn<Settings>(tx, SETTINGS),
      { retryContention: false },
    );
    expect(inside).toEqual({
      lock_timeout: '2s',
      transaction_timeout: '10s',
      statement_timeout: '5s',
      transaction_isolation: 'read committed',
      transaction_read_only: 'off',
    });

    // set_config(…, true) is local: the pooled connection is back to its defaults.
    const [outside] = await app.orm.em.fork().execute<Settings[]>(SETTINGS);
    expect(outside?.lock_timeout).toBe('0');
    expect(outside?.transaction_timeout).toBe('0');
  });

  it('runs a read-only snapshot with the reconciliation limits', async () => {
    const inside = await app.unitOfWork.run(
      (tx) => sqlIn<Settings>(tx, SETTINGS),
      { retryContention: false, mode: 'read-only-snapshot' },
    );
    expect(inside).toMatchObject({
      transaction_timeout: '35s',
      statement_timeout: '30s',
      transaction_isolation: 'repeatable read',
      transaction_read_only: 'on',
    });
  });
});

describe('atomicity', () => {
  it('leaves no row when the callback fails after its third write', async () => {
    const { opening } = await openWallet(database.owner);
    const holder = walletRow();
    const pending = pendingRow(holder, {
      next_reference_attempt_at: new Date(Date.now() - 1000),
    });
    await database.owner.begin(async (tx) => {
      await insertRow(tx, 'wallets', holder);
      await insertRow(tx, 'wager_transactions', pending);
    });
    const message = InboxMessage.receive({
      consumerName: 'uow-consumer',
      messageId: newId(),
      payloadHash: 'v1:abc',
      idempotencyKey: `key-${newId()}`,
      transactionId: opening.id as string,
      at: new Date(),
    });
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: Money.zero('BRL'),
      at: new Date(),
    });
    const injected = new Error('injected after the third write');

    const error = await rejectionOf(
      app.unitOfWork.run(
        async (tx) => {
          // Immediate SQL, then a write that waits for the flush.
          expect(await tx.inbox.insertIfAbsent(message)).toBe(true);
          expect(
            await tx.transactions.pushBack(pending.id as string, 60_000),
          ).toBe(true);
          await tx.wallets.insert(wallet);
          throw injected;
        },
        { retryContention: false },
      ),
    );

    expect(error).toBe(injected);
    const app_ = database.app;
    expect(
      await app_`SELECT 1 FROM inbox WHERE message_id = ${message.messageId}`,
    ).toHaveLength(0);
    expect(
      await app_`SELECT 1 FROM wallets WHERE id = ${wallet.id}`,
    ).toHaveLength(0);
    const rows: { due: boolean }[] = await app_`
      SELECT next_reference_attempt_at <= now() AS due FROM wager_transactions WHERE id = ${pending.id}`;
    expect(rows.map((row) => row.due)).toEqual([true]);
  });

  it('leaves no row when the commit itself fails', async () => {
    const wallet = Wallet.open({
      id: newId(),
      playerId: newId(),
      initialBalance: Money.zero('BRL'),
      at: new Date(),
    });
    // The inbox foreign key is deferred: it fails at COMMIT, after the flush.
    const orphan = InboxMessage.receive({
      consumerName: 'uow-consumer',
      messageId: newId(),
      payloadHash: 'v1:abc',
      idempotencyKey: `key-${newId()}`,
      transactionId: newId(),
      at: new Date(),
    });

    const error = await rejectionOf(
      app.unitOfWork.run(
        async (tx) => {
          await tx.wallets.insert(wallet);
          await tx.inbox.insertIfAbsent(orphan);
        },
        { retryContention: false },
      ),
    );

    expect((error as { constraint?: string }).constraint).toBe(
      'inbox_transaction_id_fkey',
    );
    expect(
      await database.app`SELECT 1 FROM wallets WHERE id = ${wallet.id}`,
    ).toHaveLength(0);
  });
});

describe('contention', () => {
  it('raises ContentionError on transaction_timeout, and the next call gets a new connection', async () => {
    const single = await startInProcess(infrastructure, {
      env: { DATABASE_POOL_MAX: '1' },
      overrides: { timeouts: { transactionTimeoutMs: 200 } },
    });
    try {
      let before = 0;
      const error = await rejectionOf(
        single.unitOfWork.run(
          async (tx) => {
            before = (
              await sqlIn<{ pid: number }>(tx, 'SELECT pg_backend_pid() AS pid')
            ).pid;
            await sqlIn(tx, 'SELECT pg_sleep(1)');
          },
          { retryContention: false },
        ),
      );
      expect(error).toBeInstanceOf(ContentionError);
      expect((error as ContentionError).reason).toBe('transaction timeout');

      const after = await single.unitOfWork.run(
        async (tx) =>
          (await sqlIn<{ pid: number }>(tx, 'SELECT pg_backend_pid() AS pid'))
            .pid,
        { retryContention: false },
      );
      expect(after).toBeNumber();
      expect(after).not.toBe(before);
    } finally {
      await single.close();
    }
  });

  it('raises ContentionError on lock_timeout, and retries only when asked', async () => {
    const { wallet } = await openWallet(database.owner);
    let attempts = 0;
    const counting = await startInProcess(infrastructure, {
      overrides: {
        timeouts: { lockTimeoutMs: 100 },
        retryContention: async (attempt) => {
          for (;;) {
            attempts += 1;
            try {
              return await attempt();
            } catch (error) {
              if (!(error instanceof ContentionError) || attempts >= 3)
                throw error;
            }
          }
        },
      },
    });
    try {
      const lockWallet = (retryContention: boolean) =>
        counting.unitOfWork.run(
          (tx) => tx.wallets.lock(wallet.id as string, 'wait'),
          {
            retryContention,
          },
        );

      await database.owner.begin(async (tx) => {
        await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR UPDATE`;

        const once = await rejectionOf(lockWallet(false));
        expect(once).toBeInstanceOf(ContentionError);
        expect((once as ContentionError).reason).toBe('lock timeout');
        expect(attempts).toBe(0);

        expect(await rejectionOf(lockWallet(true))).toBeInstanceOf(
          ContentionError,
        );
        expect(attempts).toBe(3);

        // A busy wallet is skipped, not waited for.
        expect(
          await counting.unitOfWork.run(
            (tx2) => tx2.wallets.lock(wallet.id as string, 'skip-locked'),
            { retryContention: false },
          ),
        ).toBeNull();
      });
    } finally {
      await counting.close();
    }
  });
});
