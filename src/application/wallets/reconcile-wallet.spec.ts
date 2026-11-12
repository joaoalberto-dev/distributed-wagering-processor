import { beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryUnitOfWork } from '../../../test/support/fakes/in-memory-unit-of-work.js';
import { RecordingLogger } from '../../../test/support/fakes/recording-logger.js';
import { RecordingTelemetry } from '../../../test/support/fakes/recording-telemetry.js';
import { SequentialIds } from '../../../test/support/fakes/sequential-ids.js';
import { rejectionOf } from '../../../test/support/rejection-of.js';
import { Money } from '../../domain/money/money.js';
import { WalletNotFound } from '../errors.js';
import { OpenWallet } from './open-wallet.js';
import { ReconcileWallet } from './reconcile-wallet.js';

let uow: InMemoryUnitOfWork;
let telemetry: RecordingTelemetry;
let logger: RecordingLogger;
let reconcile: ReconcileWallet;

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  telemetry = new RecordingTelemetry();
  logger = new RecordingLogger();
  reconcile = new ReconcileWallet(uow, telemetry, logger);
});

async function opened(amount: string): Promise<string> {
  const view = await new OpenWallet(
    uow,
    uow.clock,
    new SequentialIds(),
  ).execute({
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: 'correlation-1',
  });
  return view.id;
}

describe('ReconcileWallet', () => {
  it('reports a consistent wallet in a read-only snapshot, silently', async () => {
    const walletId = await opened('100.00');
    const report = await reconcile.execute(walletId);
    expect(report.toJSON()).toEqual({
      walletId,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
      issues: [],
    });
    expect(uow.runs.at(-1)).toEqual({
      retryContention: true,
      mode: 'read-only-snapshot',
    });
    expect(telemetry.calls).toEqual([]);
    expect(logger.warnings).toEqual([]);
  });

  it('flags a corrupted balance, counts it, and logs IDs without amounts', async () => {
    const walletId = await opened('100.00');
    const state = uow.store.wallets.get(walletId);
    if (state === undefined) throw new Error('wallet missing');
    uow.store.wallets.set(walletId, {
      ...state,
      balance: Money.from({ amount: '90.00', currency: 'BRL' }),
    });

    const report = await reconcile.execute(walletId);
    expect(report.consistent).toBe(false);
    expect(report.toJSON().difference).toEqual({
      amount: '-10.00',
      currency: 'BRL',
    });
    expect(report.issues).toEqual([{ code: 'BALANCE_MISMATCH' }]);
    expect(telemetry.of('reconciliationDivergence')).toEqual([
      ['BALANCE_MISMATCH'],
    ]);
    expect(logger.warnings).toEqual([
      {
        message: 'reconciliation found divergences',
        fields: { walletId, issues: ['BALANCE_MISMATCH'], checkedEntries: 1 },
      },
    ]);
    expect(JSON.stringify(logger.warnings)).not.toMatch(/\d+\.\d{2}/);
  });

  it('raises WalletNotFound for an unknown wallet', async () => {
    expect(
      await rejectionOf(
        reconcile.execute('0192f291-27dd-7d3f-8071-5f8685deef37'),
      ),
    ).toBeInstanceOf(WalletNotFound);
  });
});
