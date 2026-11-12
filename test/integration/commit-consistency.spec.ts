/**
 * The deferred constraint triggers refuse, at COMMIT, any write as the app
 * role that would leave a wallet out of step with its ledger.
 */
import { describe, expect, it } from 'bun:test';
import {
  commitViolationOf,
  entryRow,
  insertRow,
  openWallet,
  pendingRow,
  transactionRow,
  useDatabase,
} from '../support/database.js';
import { useInfrastructure } from '../support/infrastructure.js';

const infrastructure = useInfrastructure('commit-consistency');
const database = useDatabase(infrastructure);

const WALLET_TRIGGER = 'wallets_consistency_trg';
const ENTRY_TRIGGER = 'wallet_ledger_entries_consistency_trg';
const TRANSACTION_TRIGGER = 'wager_transactions_consistency_trg';

describe('commit-time consistency', () => {
  it('commits a debit written to the transaction, the ledger, and the wallet together', async () => {
    const { wallet } = await openWallet(database.owner);
    const bet = transactionRow(wallet);
    await database.app.begin(async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(tx, 'wallet_ledger_entries', entryRow(bet));
      await tx`UPDATE wallets SET balance = 75.00, version = 2 WHERE id = ${wallet.id}`;
    });
    const rows: unknown[] =
      await database.app`SELECT balance, version FROM wallets WHERE id = ${wallet.id}`;
    expect(rows).toEqual([{ balance: '75.00', version: 2 }]);
  });

  it('refuses a ledger entry without the wallet update', async () => {
    const { wallet } = await openWallet(database.owner);
    const bet = transactionRow(wallet);
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(tx, 'wallet_ledger_entries', entryRow(bet));
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);
  });

  it('refuses a PROCESSED transaction that moves the balance without its entry', async () => {
    const { wallet } = await openWallet(database.owner);
    const violation = await commitViolationOf(database.app, (tx) =>
      insertRow(tx, 'wager_transactions', transactionRow(wallet)),
    );
    expect(violation.constraint).toBe(TRANSACTION_TRIGGER);
  });

  it('refuses a pending transaction decided as PROCESSED without its entry', async () => {
    const { wallet } = await openWallet(database.owner);
    const pending = pendingRow(wallet);
    await insertRow(database.app, 'wager_transactions', pending);
    const violation = await commitViolationOf(
      database.app,
      (tx) =>
        tx`UPDATE wager_transactions
           SET status = 'PROCESSED', result_balance_amount = 125.00,
               result_balance_currency = 'BRL', processed_at = now()
           WHERE id = ${pending.id}`,
    );
    expect(violation.constraint).toBe(TRANSACTION_TRIGGER);
  });

  it('commits a PROCESSED LOSS, which has no entry', async () => {
    const { wallet } = await openWallet(database.owner);
    await insertRow(
      database.app,
      'wager_transactions',
      transactionRow(wallet, {
        kind: 'LOSS',
        amount: '0.00',
        result_balance_amount: '100.00',
      }),
    );
  });

  it('refuses a wallet update without a ledger entry', async () => {
    const { wallet } = await openWallet(database.owner);
    const violation = await commitViolationOf(database.app, async (tx) => {
      await tx`UPDATE wallets SET balance = 80.00 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(WALLET_TRIGGER);
  });

  it('refuses a wallet opened with a balance but no OPENING entry', async () => {
    const { wallet } = await openWallet(database.owner);
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wallets', {
        ...wallet,
        id: Bun.randomUUIDv7(),
        player_id: Bun.randomUUIDv7(),
      });
    });
    expect(violation.constraint).toBe(WALLET_TRIGGER);
  });

  it('refuses an entry in the wrong direction for its kind', async () => {
    const { wallet } = await openWallet(database.owner);
    const bet = transactionRow(wallet, { result_balance_amount: '125.00' });
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(bet, { direction: 'CREDIT', balance_after: '125.00' }),
      );
      await tx`UPDATE wallets SET balance = 125.00, version = 2 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);
  });

  it('refuses a ROLLBACK entry that repeats the direction of the entry it reverses', async () => {
    const { wallet } = await openWallet(database.owner);
    const bet = transactionRow(wallet);
    await database.app.begin(async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(tx, 'wallet_ledger_entries', entryRow(bet));
      await tx`UPDATE wallets SET balance = 75.00, version = 2 WHERE id = ${wallet.id}`;
    });
    const rollback = transactionRow(wallet, {
      kind: 'ROLLBACK',
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
      result_balance_amount: '50.00',
    });
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', rollback);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(rollback, {
          balance_before: '75.00',
          balance_after: '50.00',
          wallet_version: 3,
        }),
      );
      await tx`UPDATE wallets SET balance = 50.00, version = 3 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);
  });

  it('refuses an entry for a transaction that is not PROCESSED', async () => {
    const { wallet } = await openWallet(database.owner);
    const rejected = transactionRow(wallet, {
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      result_balance_amount: '100.00',
    });
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', rejected);
      await insertRow(tx, 'wallet_ledger_entries', entryRow(rejected));
      await tx`UPDATE wallets SET balance = 75.00, version = 2 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);
  });

  it('refuses a forged balance_before even when the wallet update matches it', async () => {
    const { wallet } = await openWallet(database.owner);
    const bet = transactionRow(wallet, { result_balance_amount: '25.00' });
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(bet, { balance_before: '50.00', balance_after: '25.00' }),
      );
      await tx`UPDATE wallets SET balance = 25.00, version = 2 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);
  });

  it('refuses a version gap', async () => {
    const { wallet } = await openWallet(database.owner);
    const bet = transactionRow(wallet);
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', bet);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(bet, { wallet_version: 3 }),
      );
      await tx`UPDATE wallets SET balance = 75.00, version = 3 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);
  });

  it('accepts version 2 from zero on a wallet opened at zero, and refuses it from anything else', async () => {
    const wallet = {
      id: Bun.randomUUIDv7(),
      player_id: Bun.randomUUIDv7(),
      currency: 'BRL',
      balance: '0.00',
      version: 1,
    };
    await insertRow(database.app, 'wallets', wallet);
    const forged = transactionRow(wallet, {
      kind: 'WIN',
      result_balance_amount: '35.00',
    });
    const violation = await commitViolationOf(database.app, async (tx) => {
      await insertRow(tx, 'wager_transactions', forged);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(forged, {
          direction: 'CREDIT',
          balance_before: '10.00',
          balance_after: '35.00',
        }),
      );
      await tx`UPDATE wallets SET balance = 35.00, version = 2 WHERE id = ${wallet.id}`;
    });
    expect(violation.constraint).toBe(ENTRY_TRIGGER);

    const win = transactionRow(wallet, {
      kind: 'WIN',
      result_balance_amount: '25.00',
    });
    await database.app.begin(async (tx) => {
      await insertRow(tx, 'wager_transactions', win);
      await insertRow(
        tx,
        'wallet_ledger_entries',
        entryRow(win, {
          direction: 'CREDIT',
          balance_before: '0.00',
          balance_after: '25.00',
        }),
      );
      await tx`UPDATE wallets SET balance = 25.00, version = 2 WHERE id = ${wallet.id}`;
    });
  });
});
