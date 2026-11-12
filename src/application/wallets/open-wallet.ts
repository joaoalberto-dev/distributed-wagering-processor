import { LedgerDirection } from '../../domain/ledger/ledger-direction.js';
import type { Money } from '../../domain/money/money.js';
import { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import { WalletAlreadyExists } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { WalletView } from '../ports/queries.js';
import type { TxContext, UnitOfWork } from '../ports/unit-of-work.js';
import { applyOutcome } from '../wagering/apply-outcome.js';

export type OpenWalletCommand = {
  readonly playerId: string;
  /** Validated by the contract: non-negative and within the ceiling. */
  readonly initialBalance: Money;
  readonly correlationId: string;
};

/**
 * Opens a wallet at version 1. A positive opening balance is recorded in the
 * same SQL transaction as an `OPENING` transaction with its `CREDIT` entry
 * and events; a zero opening writes the wallet alone. A second wallet for the
 * same player and currency raises `WalletAlreadyExists` with the existing ID.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    try {
      const wallet = await this.unitOfWork.run((tx) => this.open(tx, command), {
        retryContention: true,
      });
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toProps(),
        version: wallet.version,
      };
    } catch (error) {
      // A concurrent open committed first: the unique constraint names no ID.
      if (
        error instanceof WalletAlreadyExists &&
        error.walletId === undefined
      ) {
        throw await this.existing(command, error);
      }
      throw error;
    }
  }

  private async open(
    tx: TxContext,
    command: OpenWalletCommand,
  ): Promise<Wallet> {
    const { playerId, initialBalance } = command;
    const existing = await tx.wallets.findByPlayerAndCurrency(
      playerId,
      initialBalance.currency,
    );
    if (existing !== null) throw new WalletAlreadyExists(existing.id);

    const at = this.clock.now();
    const wallet = Wallet.open({
      id: this.ids.uuidv7(),
      playerId,
      initialBalance,
      at,
    });
    await tx.wallets.insert(wallet);
    if (initialBalance.isZero()) return wallet;

    const opening = WagerTransaction.open({
      id: this.ids.uuidv7(),
      walletId: wallet.id,
      playerId,
      money: initialBalance,
      correlationId: command.correlationId,
      at,
    });
    await applyOutcome(
      tx,
      opening,
      wallet,
      {
        kind: 'process',
        effect: { direction: LedgerDirection.Credit, amount: initialBalance },
      },
      {
        ids: this.ids,
        correlationId: command.correlationId,
        causationId: wallet.id,
        occurredAt: at,
        // An OPENING never waits for a reference.
        referenceTtlMs: 0,
      },
    );
    return wallet;
  }

  private async existing(
    command: OpenWalletCommand,
    race: WalletAlreadyExists,
  ): Promise<WalletAlreadyExists> {
    const winner = await this.unitOfWork.run(
      (tx) =>
        tx.wallets.findByPlayerAndCurrency(
          command.playerId,
          command.initialBalance.currency,
        ),
      { retryContention: true },
    );
    return winner === null
      ? race
      : new WalletAlreadyExists(winner.id, { cause: race });
  }
}
