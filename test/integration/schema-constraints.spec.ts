/**
 * Every CHECK, unique index, foreign key, and trigger rejects a violating
 * write by the app role with its own name. Immediate rules run in a
 * transaction that is rolled back; the commit-time rules have their own spec.
 */
import type { SQL } from 'bun';
import { beforeAll, describe, expect, it } from 'bun:test';
import {
  commitViolationOf,
  entryRow,
  insertRow,
  newId,
  type OpenedWallet,
  openWallet,
  pendingRow,
  Rollback,
  type Row,
  transactionRow,
  useDatabase,
  violationOf,
  walletRow,
} from '../support/database.js';
import { useInfrastructure } from '../support/infrastructure.js';

const infrastructure = useInfrastructure('schema-constraints');
const database = useDatabase(infrastructure);

/** One violating write per case: the table it targets and what it does. */
type Case = readonly [name: string, write: (tx: SQL) => Promise<unknown>];

/** Runs allowed statements as the app role and rolls them back. */
async function rolledBack(
  statements: (tx: SQL) => Promise<unknown>,
): Promise<void> {
  try {
    await database.app.begin(async (tx) => {
      await statements(tx);
      throw new Rollback('rolled back on purpose');
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function expectViolation(
  constraint: string,
  write: (tx: SQL) => Promise<unknown>,
): Promise<void> {
  const violation = await violationOf(database.app, write);
  expect(violation.constraint).toBe(constraint);
}

/** A fresh wallet at zero and a provider BET of it, inserted in `tx`. */
async function withTransaction(
  tx: SQL,
  overrides: Row = {},
): Promise<{ wallet: Row; transaction: Row }> {
  const wallet = walletRow();
  await insertRow(tx, 'wallets', wallet);
  const transaction = transactionRow(wallet, overrides);
  await insertRow(tx, 'wager_transactions', transaction);
  return { wallet, transaction };
}

function outboxRow(overrides: Row = {}): Row {
  return {
    id: newId(),
    aggregate_id: newId(),
    wallet_id: newId(),
    event_type: 'WagerTransactionProcessed',
    event_version: 1,
    payload: JSON.stringify({ eventId: 'x' }),
    occurred_at: new Date(),
    ...overrides,
  };
}

describe('wallets', () => {
  const cases: Case[] = [
    [
      'wallets_balance_check',
      (tx) => insertRow(tx, 'wallets', walletRow({ balance: '-0.01' })),
    ],
    [
      'wallets_version_check',
      (tx) => insertRow(tx, 'wallets', walletRow({ version: 0 })),
    ],
    [
      'wallets_currency_check',
      (tx) => insertRow(tx, 'wallets', walletRow({ currency: 'brl' })),
    ],
    [
      'wallets_player_id_currency_key',
      async (tx) => {
        const first = walletRow();
        await insertRow(tx, 'wallets', first);
        await insertRow(
          tx,
          'wallets',
          walletRow({ player_id: first.player_id }),
        );
      },
    ],
  ];
  it.each(cases)('rejects with %s', expectViolation);

  it('accepts a CURRENCY_MISMATCH rejection whose snapshot is in the wallet currency', async () => {
    await rolledBack((tx) =>
      withTransaction(tx, {
        currency: 'USD',
        status: 'REJECTED',
        failure_code: 'CURRENCY_MISMATCH',
        result_balance_currency: 'BRL',
      }),
    );
  });

  it.each([
    ['player_id', newId()],
    ['currency', 'USD'],
    ['id', newId()],
  ])(
    'refuses a change of %s with wallets_immutable_trg',
    async (column, value) => {
      const wallet = walletRow();
      await insertRow(database.app, 'wallets', wallet);
      await expectViolation(
        'wallets_immutable_trg',
        (tx) =>
          tx`UPDATE wallets SET ${tx({ [column]: value })} WHERE id = ${wallet.id}`,
      );
    },
  );
});

describe('wager_transactions', () => {
  const cases: Case[] = [
    [
      'wager_transactions_kind_check',
      (tx) => withTransaction(tx, { kind: 'JACKPOT' }),
    ],
    [
      'wager_transactions_lifecycle_trg',
      (tx) =>
        withTransaction(tx, {
          status: 'PENDING',
          result_balance_amount: null,
          result_balance_currency: null,
          processed_at: null,
        }),
    ],
    [
      'wager_transactions_currency_check',
      (tx) => withTransaction(tx, { currency: 'BR1' }),
    ],
    [
      'wager_transactions_attempts_check',
      (tx) => withTransaction(tx, { attempts: -1 }),
    ],
    [
      'wager_transactions_amount_check',
      (tx) => withTransaction(tx, { amount: '0.00' }),
    ],
    [
      'wager_transactions_amount_check',
      (tx) => withTransaction(tx, { kind: 'LOSS', amount: '-1.00' }),
    ],
    [
      'wager_transactions_reference_check',
      (tx) => withTransaction(tx, { kind: 'REFUND' }),
    ],
    [
      'wager_transactions_reference_check',
      (tx) =>
        withTransaction(tx, { reference_external_transaction_id: 'ext-0' }),
    ],
    [
      'wager_transactions_reference_check',
      (tx) =>
        withTransaction(tx, {
          kind: 'WIN',
          external_transaction_id: 'ext-self',
          reference_external_transaction_id: 'ext-self',
        }),
    ],
    [
      'wager_transactions_provider_fields_check',
      (tx) => withTransaction(tx, { round_id: null }),
    ],
    [
      'wager_transactions_provider_fields_check',
      (tx) => withTransaction(tx, { kind: 'OPENING' }),
    ],
    [
      'wager_transactions_failure_code_check',
      (tx) => withTransaction(tx, { status: 'REJECTED' }),
    ],
    [
      'wager_transactions_failure_code_check',
      (tx) => withTransaction(tx, { failure_code: 'INSUFFICIENT_FUNDS' }),
    ],
    [
      'wager_transactions_failure_code_check',
      (tx) =>
        withTransaction(tx, {
          status: 'REJECTED',
          failure_code: 'PROCESSING_FAILED',
        }),
    ],
    [
      'wager_transactions_result_check',
      (tx) => withTransaction(tx, { result_balance_amount: null }),
    ],
    [
      'wager_transactions_result_check',
      (tx) => withTransaction(tx, { result_balance_currency: 'USD' }),
    ],
    [
      'wager_transactions_result_check',
      (tx) =>
        withTransaction(tx, {
          status: 'REJECTED',
          failure_code: 'CURRENCY_MISMATCH',
          result_balance_currency: null,
        }),
    ],
    [
      'wager_transactions_scheduling_check',
      async (tx) => {
        const wallet = walletRow();
        await insertRow(tx, 'wallets', wallet);
        await insertRow(
          tx,
          'wager_transactions',
          pendingRow(wallet, { next_reference_attempt_at: null }),
        );
      },
    ],
    [
      'wager_transactions_lifecycle_trg',
      (tx) =>
        withTransaction(tx, {
          status: 'FAILED',
          failure_code: 'PROCESSING_FAILED',
          result_balance_amount: null,
          result_balance_currency: null,
        }),
    ],
    [
      'wager_transactions_provider_id_idempotency_key_key',
      async (tx) => {
        const { wallet, transaction } = await withTransaction(tx);
        await insertRow(
          tx,
          'wager_transactions',
          transactionRow(wallet, {
            idempotency_key: transaction.idempotency_key,
          }),
        );
      },
    ],
    [
      'wager_transactions_provider_id_external_transaction_id_key',
      async (tx) => {
        const { wallet, transaction } = await withTransaction(tx);
        await insertRow(
          tx,
          'wager_transactions',
          transactionRow(wallet, {
            external_transaction_id: transaction.external_transaction_id,
          }),
        );
      },
    ],
    [
      'wager_transactions_wallet_id_fkey',
      (tx) => insertRow(tx, 'wager_transactions', transactionRow(walletRow())),
    ],
    [
      'wager_transactions_reference_transaction_id_wallet_id_fkey',
      async (tx) => {
        const { transaction: bet } = await withTransaction(tx);
        await withTransaction(tx, {
          kind: 'WIN',
          reference_external_transaction_id: bet.external_transaction_id,
          reference_transaction_id: bet.id,
        });
      },
    ],
    [
      'wager_transactions_reference_transaction_id_key',
      async (tx) => {
        const { wallet, transaction: bet } = await withTransaction(tx);
        const reversal = (kind: string) =>
          transactionRow(wallet, {
            kind,
            reference_external_transaction_id: bet.external_transaction_id,
            reference_transaction_id: bet.id,
          });
        await insertRow(tx, 'wager_transactions', reversal('REFUND'));
        await insertRow(tx, 'wager_transactions', reversal('ROLLBACK'));
      },
    ],
    [
      'wager_transactions_opening_wallet_id_key',
      async (tx) => {
        const wallet = walletRow();
        await insertRow(tx, 'wallets', wallet);
        const opening = () =>
          transactionRow(wallet, {
            provider_id: null,
            external_transaction_id: null,
            idempotency_key: null,
            payload_hash: null,
            round_id: null,
            game_id: null,
            kind: 'OPENING',
          });
        await insertRow(tx, 'wager_transactions', opening());
        await insertRow(tx, 'wager_transactions', opening());
      },
    ],
  ];
  it.each(cases)('rejects with %s', expectViolation);

  it('accepts a CURRENCY_MISMATCH rejection whose snapshot is in the wallet currency', async () => {
    await rolledBack((tx) =>
      withTransaction(tx, {
        currency: 'USD',
        status: 'REJECTED',
        failure_code: 'CURRENCY_MISMATCH',
        result_balance_currency: 'BRL',
      }),
    );
  });

  it.each([
    ['wager_transactions_status_persisted_check', 'PENDING'],
    ['wager_transactions_status_check', 'DONE'],
  ])(
    'keeps %s as a second barrier when the triggers are bypassed',
    async (constraint, status) => {
      const violation = await violationOf(database.owner, async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await withTransaction(tx, {
          status,
          result_balance_amount: null,
          result_balance_currency: null,
          processed_at: null,
        });
      });
      expect(violation.constraint).toBe(constraint);
    },
  );

  describe('updates of committed rows', () => {
    let opened: OpenedWallet;
    let pending: Row;
    let rejected: Row;

    beforeAll(async () => {
      opened = await openWallet(database.owner);
      pending = pendingRow(opened.wallet);
      rejected = transactionRow(opened.wallet, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
        result_balance_amount: '100.00',
      });
      await insertRow(database.app, 'wager_transactions', pending);
      await insertRow(database.app, 'wager_transactions', rejected);
    });

    it('refuses any update of a terminal row, even a no-op', async () => {
      await expectViolation(
        'wager_transactions_lifecycle_trg',
        (tx) =>
          tx`UPDATE wager_transactions SET status = status WHERE id = ${rejected.id}`,
      );
      await expectViolation(
        'wager_transactions_lifecycle_trg',
        (tx) =>
          tx`UPDATE wager_transactions SET status = 'PROCESSED', failure_code = NULL WHERE id = ${rejected.id}`,
      );
    });

    it('refuses a no-op update of a pending row', async () => {
      await expectViolation(
        'wager_transactions_lifecycle_trg',
        (tx) =>
          tx`UPDATE wager_transactions SET attempts = attempts WHERE id = ${pending.id}`,
      );
    });

    it('lets a reschedule change only the attempts and the next attempt', async () => {
      await expectViolation(
        'wager_transactions_lifecycle_trg',
        (tx) =>
          tx`UPDATE wager_transactions SET attempts = 1, reference_expires_at = now() WHERE id = ${pending.id}`,
      );
      await rolledBack(async (tx) => {
        const rows: unknown[] = await tx`
          UPDATE wager_transactions
             SET attempts = 1, next_reference_attempt_at = now() + interval '1 second'
           WHERE id = ${pending.id} RETURNING id`;
        expect(rows).toHaveLength(1);
      });
    });

    it('lets a decision change only the result columns', async () => {
      await expectViolation(
        'wager_transactions_lifecycle_trg',
        (tx) =>
          tx`UPDATE wager_transactions
             SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
                 result_balance_amount = 100.00, result_balance_currency = 'BRL',
                 processed_at = now(), attempts = attempts + 1
             WHERE id = ${pending.id}`,
      );
    });

    it.each([
      ['amount', '30.00'],
      ['round_id', 'round-2'],
      ['idempotency_key', 'another-key'],
      ['correlation_id', 'another'],
    ])(
      'refuses a change of %s with wager_transactions_identity_trg',
      async (column, value) => {
        await expectViolation(
          'wager_transactions_identity_trg',
          (tx) =>
            tx`UPDATE wager_transactions SET ${tx({ [column]: value })} WHERE id = ${pending.id}`,
        );
      },
    );
  });
});

describe('wallet_ledger_entries', () => {
  /** A debit 100.00 → 75.00 at version 2 of a fresh wallet, with `overrides`. */
  const entry = (overrides: Row) => async (tx: SQL) => {
    const { transaction } = await withTransaction(tx);
    await insertRow(
      tx,
      'wallet_ledger_entries',
      entryRow(transaction, overrides),
    );
  };
  const cases: Case[] = [
    ['wallet_ledger_entries_direction_check', entry({ direction: 'SIDEWAYS' })],
    ['wallet_ledger_entries_currency_check', entry({ currency: 'XX' })],
    [
      'wallet_ledger_entries_amount_check',
      entry({ amount: '0.00', balance_after: '100.00' }),
    ],
    [
      'wallet_ledger_entries_balance_check',
      entry({ balance_before: '10.00', balance_after: '-15.00' }),
    ],
    [
      'wallet_ledger_entries_arithmetic_check',
      entry({ balance_after: '80.00' }),
    ],
    [
      'wallet_ledger_entries_wallet_version_check',
      entry({ wallet_version: 0 }),
    ],
    [
      'wallet_ledger_entries_transaction_id_key',
      async (tx) => {
        const { transaction } = await withTransaction(tx);
        await insertRow(tx, 'wallet_ledger_entries', entryRow(transaction));
        await insertRow(
          tx,
          'wallet_ledger_entries',
          entryRow(transaction, { wallet_version: 3 }),
        );
      },
    ],
    [
      'wallet_ledger_entries_wallet_id_wallet_version_key',
      async (tx) => {
        const { wallet, transaction } = await withTransaction(tx);
        const second = transactionRow(wallet);
        await insertRow(tx, 'wager_transactions', second);
        await insertRow(tx, 'wallet_ledger_entries', entryRow(transaction));
        await insertRow(tx, 'wallet_ledger_entries', entryRow(second));
      },
    ],
    [
      'wallet_ledger_entries_transaction_id_wallet_id_fkey',
      async (tx) => {
        const { transaction } = await withTransaction(tx);
        const other = walletRow();
        await insertRow(tx, 'wallets', other);
        await insertRow(
          tx,
          'wallet_ledger_entries',
          entryRow(transaction, { wallet_id: other.id }),
        );
      },
    ],
  ];
  it.each(cases)('rejects with %s', expectViolation);

  it('accepts a CURRENCY_MISMATCH rejection whose snapshot is in the wallet currency', async () => {
    await rolledBack((tx) =>
      withTransaction(tx, {
        currency: 'USD',
        status: 'REJECTED',
        failure_code: 'CURRENCY_MISMATCH',
        result_balance_currency: 'BRL',
      }),
    );
  });

  it('refuses an update of a committed entry', async () => {
    const { opening } = await openWallet(database.owner);
    await expectViolation(
      'wallet_ledger_entries_no_update_trg',
      (tx) =>
        tx`UPDATE wallet_ledger_entries SET created_at = now() WHERE transaction_id = ${opening.id}`,
    );
  });
});

describe('inbox', () => {
  function inboxRow(transactionId: unknown, overrides: Row = {}): Row {
    return {
      consumer_name: 'schema-consumer',
      message_id: newId(),
      payload_hash: 'v1:abc',
      idempotency_key: `key-${newId()}`,
      transaction_id: transactionId,
      ...overrides,
    };
  }

  it('rejects a second row of the same message with inbox_pkey', async () => {
    const { opening } = await openWallet(database.owner);
    await expectViolation('inbox_pkey', async (tx) => {
      const row = inboxRow(opening.id);
      await insertRow(tx, 'inbox', row);
      await insertRow(
        tx,
        'inbox',
        inboxRow(opening.id, { message_id: row.message_id }),
      );
    });
  });

  it('refuses an update of a committed row, even for the owner', async () => {
    const { opening } = await openWallet(database.owner);
    const row = inboxRow(opening.id);
    await database.owner.begin((tx) => insertRow(tx, 'inbox', row));
    for (const sql of [database.app, database.owner]) {
      const violation = await violationOf(
        sql,
        (tx) =>
          tx`UPDATE inbox SET payload_hash = 'v1:other' WHERE message_id = ${row.message_id}`,
      );
      expect(violation.constraint).toBe('inbox_no_update_trg');
    }
  });

  it('checks inbox_transaction_id_fkey at commit, so the row may precede its transaction', async () => {
    const violation = await commitViolationOf(database.app, (tx) =>
      insertRow(tx, 'inbox', inboxRow(newId())),
    );
    expect(violation.constraint).toBe('inbox_transaction_id_fkey');

    await database.app.begin(async (tx) => {
      const wallet = walletRow();
      const transaction = transactionRow(wallet, {
        kind: 'LOSS',
        amount: '0.00',
      });
      await insertRow(tx, 'inbox', inboxRow(transaction.id));
      await insertRow(tx, 'wallets', wallet);
      await insertRow(tx, 'wager_transactions', transaction);
    });
  });
});

describe('outbox', () => {
  const cases: Case[] = [
    [
      'outbox_attempts_check',
      (tx) => insertRow(tx, 'outbox', outboxRow({ attempts: -1 })),
    ],
    [
      'outbox_event_version_check',
      (tx) => insertRow(tx, 'outbox', outboxRow({ event_version: 0 })),
    ],
  ];
  it.each(cases)('rejects with %s', expectViolation);

  it('accepts a CURRENCY_MISMATCH rejection whose snapshot is in the wallet currency', async () => {
    await rolledBack((tx) =>
      withTransaction(tx, {
        currency: 'USD',
        status: 'REJECTED',
        failure_code: 'CURRENCY_MISMATCH',
        result_balance_currency: 'BRL',
      }),
    );
  });

  describe('a published event', () => {
    const published = outboxRow();

    beforeAll(async () => {
      await insertRow(database.app, 'outbox', published);
      await database.app`UPDATE outbox SET published_at = now() WHERE id = ${published.id}`;
    });

    it('cannot return to unpublished', async () => {
      await expectViolation(
        'outbox_published_at_trg',
        (tx) =>
          tx`UPDATE outbox SET published_at = NULL WHERE id = ${published.id}`,
      );
    });

    it('cannot change its publication time', async () => {
      await expectViolation(
        'outbox_published_at_trg',
        (tx) =>
          tx`UPDATE outbox SET published_at = published_at + interval '1 second' WHERE id = ${published.id}`,
      );
    });

    it.each([
      ['payload', JSON.stringify({ eventId: 'rewritten' })],
      ['event_type', 'Other'],
      ['wallet_id', newId()],
    ])('cannot rewrite %s', async (column, value) => {
      await expectViolation(
        'outbox_immutable_trg',
        (tx) =>
          tx`UPDATE outbox SET ${tx({ [column]: value })} WHERE id = ${published.id}`,
      );
    });
  });
});

describe('the app role', () => {
  let opened: OpenedWallet;

  beforeAll(async () => {
    opened = await openWallet(database.owner);
  });

  it.each([
    'wallets',
    'wager_transactions',
    'wallet_ledger_entries',
    'inbox',
    'outbox',
  ])('may not DELETE or TRUNCATE %s', async (table) => {
    for (const statement of [
      `DELETE FROM ${table} WHERE false`,
      `TRUNCATE ${table}`,
    ]) {
      const violation = await violationOf(database.app, (tx) =>
        tx.unsafe(statement),
      );
      expect(violation.sqlState).toBe('42501');
    }
  });

  it('may not bypass the triggers', async () => {
    for (const statement of [
      'SET session_replication_role = replica',
      'ALTER TABLE wallets DISABLE TRIGGER USER',
    ]) {
      const violation = await violationOf(database.app, (tx) =>
        tx.unsafe(statement),
      );
      expect(violation.sqlState).toBe('42501');
    }
  });

  it('is backed by triggers that refuse DELETE and TRUNCATE even for the owner', async () => {
    for (const [table, key, id] of [
      ['wallets', 'id', opened.wallet.id],
      ['wager_transactions', 'id', opened.opening.id],
      ['wallet_ledger_entries', 'transaction_id', opened.opening.id],
    ] as const) {
      const deleted = await violationOf(database.owner, (tx) =>
        tx.unsafe(`DELETE FROM ${table} WHERE ${key} = $1`, [id]),
      );
      expect(deleted.constraint).toBe(`${table}_no_delete_trg`);
    }
    // Tables no foreign key points at; the others cannot be truncated alone anyway.
    for (const table of ['wallet_ledger_entries', 'outbox']) {
      const truncated = await violationOf(database.owner, (tx) =>
        tx.unsafe(`TRUNCATE ${table}`),
      );
      expect(truncated.constraint).toBe(`${table}_no_truncate_trg`);
    }
  });
});
