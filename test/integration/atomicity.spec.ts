/**
 * All or nothing: a failure after any write of a submission (the inbox row,
 * then the persistence step's transaction, wallet, ledger entry, and outbox
 * events) leaves no trace of the operation in any of the five tables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type {
  TxContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../../src/application/ports/unit-of-work.js';
import {
  type SubmitCommand,
  SubmitWagerTransaction,
} from '../../src/application/wagering/submit-wager-transaction.js';
import type { Application } from '../../src/bootstrap/container.js';
import { Money } from '../../src/domain/money/money.js';
import { type Row, useDatabase } from '../support/database.js';
import { externalId, playerId } from '../support/factories.js';
import { startInProcess } from '../support/in-process.js';
import { useInfrastructure } from '../support/infrastructure.js';
import { rejectionOf } from '../support/rejection-of.js';

const infrastructure = useInfrastructure('atomicity');
const database = useDatabase(infrastructure);

let app: Application;

beforeAll(async () => {
  app = await startInProcess(infrastructure);
});

afterAll(async () => {
  await app.close();
});

type Point = 'inbox' | 'transaction' | 'wallet' | 'ledger' | 'outbox';

class InjectedFailure extends Error {
  constructor(readonly point: Point) {
    super(`injected failure after the ${point} write`);
  }
}

/** Wraps `method` of `repository` so the failure comes right after its write. */
function failAfter<T extends object>(
  repository: T,
  method: keyof T,
  point: Point,
): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const bound = (...args: unknown[]): unknown =>
        (value as (...a: unknown[]) => unknown).apply(target, args);
      if (property !== method) return bound;
      return async (...args: unknown[]) => {
        await bound(...args);
        throw new InjectedFailure(point);
      };
    },
  });
}

/** The real unit of work, failing right after one write. */
class FailingUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly point: Point,
  ) {}

  run<T>(
    fn: (tx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    return this.inner.run((tx) => fn(this.wrap(tx)), options);
  }

  private wrap(tx: TxContext): TxContext {
    const point = this.point;
    return {
      wallets:
        point === 'wallet' ? failAfter(tx.wallets, 'save', point) : tx.wallets,
      transactions:
        point === 'transaction'
          ? failAfter(tx.transactions, 'insert', point)
          : tx.transactions,
      ledger:
        point === 'ledger' ? failAfter(tx.ledger, 'append', point) : tx.ledger,
      inbox:
        point === 'inbox'
          ? failAfter(tx.inbox, 'insertIfAbsent', point)
          : tx.inbox,
      outbox:
        point === 'outbox' ? failAfter(tx.outbox, 'enqueue', point) : tx.outbox,
      reconciliation: tx.reconciliation,
    };
  }
}

function submitFailingAt(point: Point): SubmitWagerTransaction {
  return new SubmitWagerTransaction(
    new FailingUnitOfWork(app.unitOfWork, point),
    app.clock,
    app.ids,
    app.metrics,
    { warn: () => undefined },
    app.providerIdentity,
    app.requestContext,
    { referenceTtlMs: 60_000 },
  );
}

async function counts(walletId: string, messageId: string): Promise<Row> {
  const [row] = (await database.owner`
    SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS transactions,
           (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
           (SELECT count(*)::int FROM outbox WHERE wallet_id = ${walletId}) AS events,
           (SELECT count(*)::int FROM inbox WHERE message_id = ${messageId}) AS inbox,
           (SELECT balance::text FROM wallets WHERE id = ${walletId}) AS balance,
           (SELECT version FROM wallets WHERE id = ${walletId}) AS version`) as Row[];
  if (row === undefined) throw new Error('no counts');
  return row;
}

describe('a failure after a write of the submission', () => {
  const points: Point[] = [
    'inbox',
    'transaction',
    'wallet',
    'ledger',
    'outbox',
  ];

  it.each(points)(
    'after the %s write leaves zero rows in all five tables',
    async (point) => {
      // Opened at zero: the wallet has no opening transaction, entry, or event.
      const wallet = await app.openWallet.execute({
        playerId: playerId(),
        initialBalance: Money.from({ amount: '0.00', currency: 'BRL' }),
        correlationId: 'atomicity',
      });
      const messageId = externalId('msg');
      const externalTransactionId = externalId('tx');
      const command: SubmitCommand = {
        operation: {
          providerId: 'provider-a',
          externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
        },
        idempotencyKey: `provider-a:${externalTransactionId}`,
        channel: 'sqs',
        correlationId: messageId,
        causationId: messageId,
        inbox: { consumerName: 'wager-transactions-consumer', messageId },
      };

      const error = await rejectionOf(submitFailingAt(point).execute(command));
      expect(error).toBeInstanceOf(InjectedFailure);
      expect(await counts(wallet.id, messageId)).toEqual({
        transactions: 0,
        entries: 0,
        events: 0,
        inbox: 0,
        balance: '0.00',
        version: 1,
      });

      // The same delivery then succeeds: nothing half-written stands in its way.
      const result = await app.submitWagerTransaction.execute(command);
      expect(result).toMatchObject({ replay: false, duplicate: false });
      expect(await counts(wallet.id, messageId)).toEqual({
        transactions: 1,
        entries: 1,
        events: 2,
        inbox: 1,
        balance: '10.00',
        version: 2,
      });
    },
  );
});
