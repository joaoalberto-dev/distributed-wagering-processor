import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { Money, type MoneyProps } from '../../domain/money/money.js';
import { settle } from '../../domain/settlement/settle.js';
import type { SubmittableKind } from '../../domain/transaction/transaction-kind.js';
import { WagerTransaction } from '../../domain/transaction/wager-transaction.js';
import {
  ExternalTransactionIdConflict,
  IdempotencyKeyConflict,
  IdentityRaceError,
  MessageIdConflict,
  WalletNotFound,
} from '../errors.js';
import { payloadHash } from '../idempotency/payload-hash.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { AppLogger } from '../ports/logger.js';
import type { ProviderIdentityPort } from '../ports/provider-identity.js';
import type { TransactionView } from '../ports/queries.js';
import type { RequestContext } from '../ports/request-context.js';
import type { Telemetry } from '../ports/telemetry.js';
import type { TxContext, UnitOfWork } from '../ports/unit-of-work.js';
import { applyOutcome } from './apply-outcome.js';
import { resolveReference } from './resolve-reference.js';
import { toTransactionView } from './wager-queries.js';

/** The validated core operation (§7), the same for HTTP and SQS. */
export type WagerOperation = {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: SubmittableKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
};

/** The SQS delivery identity, `(consumerName, envelope messageId)`. */
export type InboxDelivery = {
  readonly consumerName: string;
  readonly messageId: string;
};

export type SubmitCommand = {
  readonly operation: WagerOperation;
  readonly idempotencyKey: string;
  readonly channel: 'http' | 'sqs';
  readonly correlationId: string;
  readonly causationId: string;
  /** SQS only: the delivery recorded in the inbox with the effect. */
  readonly inbox?: InboxDelivery;
};

export type SubmitResult = {
  /** Its status is the stored one when the result is served (§7, Replay status). */
  readonly transaction: TransactionView;
  /** The stored result of an earlier submission, not a new decision. */
  readonly replay: boolean;
  /** SQS only: this delivery was already recorded for the same operation. */
  readonly duplicate: boolean;
};

export type SubmitSettings = {
  /** `reference_expires_at` of an operation that starts waiting, from now. */
  readonly referenceTtlMs: number;
};

/** The operation is already stored: a replay, or a repeated SQS delivery. */
type Found = {
  readonly transaction: WagerTransaction;
  readonly duplicate: boolean;
};

/** Raised inside the unit of work so it rolls back, then answered as a replay. */
class AlreadyStored extends Error {
  constructor(readonly found: Found) {
    super('the operation is already stored');
  }
}

/**
 * Submits one provider operation (§10): identities first, then the domain
 * checks under the wallet lock, then the one persistence step.
 *
 * 1. Without a lock, the inbox (SQS), then the key, then the external ID
 *    (§8 decision table). A stored operation is replayed read-only, whatever
 *    its status: a pending one is never resolved here.
 * 2. In one unit of work: the inbox row (SQS) before the wallet lock, the
 *    lock, the identities again, the reference, `settle`, and `applyOutcome`.
 *    An operation found stored under the lock rolls back and is replayed.
 * 3. A unique violation on an identity means another submission committed
 *    first: one re-read decides between a replay and a conflict.
 *
 * Contention retries come from the unit of work, for HTTP only.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry,
    private readonly logger: AppLogger,
    private readonly providerIdentity: ProviderIdentityPort,
    private readonly context: RequestContext,
    private readonly settings: SubmitSettings,
  ) {}

  async execute(command: SubmitCommand): Promise<SubmitResult> {
    const started = performance.now();
    const { operation, channel } = command;
    this.context.set({
      providerId: operation.providerId,
      walletId: operation.walletId,
    });
    await this.providerIdentity.authorize(operation.providerId, channel);
    const hash = payloadHash(operation);
    const retryContention = channel === 'http';

    const found = await this.unitOfWork.run(
      (tx) => this.lookup(tx, command, hash),
      { retryContention },
    );
    if (found !== null) return this.answer(command, hash, found, started);

    // Generated before the unit of work: the inbox row is written with it first.
    const transactionId = this.ids.uuidv7();
    this.context.set({ transactionId });
    let decided: WagerTransaction;
    try {
      decided = await this.unitOfWork.run(
        (tx) => this.decide(tx, command, hash, transactionId),
        { retryContention },
      );
    } catch (error) {
      if (error instanceof AlreadyStored) {
        return this.answer(command, hash, error.found, started);
      }
      if (error instanceof IdentityRaceError && error.constraint !== 'inbox') {
        this.telemetry.uniqueViolationRetry();
        const winner = await this.reread(command, hash, error);
        return this.answer(command, hash, winner, started);
      }
      throw error;
    }

    this.telemetry.transactionDecided(decided.kind, decided.status, channel);
    this.finish(channel, started);
    this.warnIfReversed(decided);
    return {
      transaction: toTransactionView(decided),
      replay: false,
      duplicate: false,
    };
  }

  /** Step 1: the unlocked reads. */
  private async lookup(
    tx: TxContext,
    command: SubmitCommand,
    hash: string,
  ): Promise<Found | null> {
    if (command.inbox !== undefined) {
      const delivery = await tx.inbox.find(
        command.inbox.consumerName,
        command.inbox.messageId,
      );
      if (delivery !== null) {
        return this.delivered(tx, delivery, command, hash);
      }
    }
    const stored = await this.identify(tx, command, hash);
    return stored === null ? null : { transaction: stored, duplicate: false };
  }

  /** Step 2: decides a new operation under the wallet lock. */
  private async decide(
    tx: TxContext,
    command: SubmitCommand,
    hash: string,
    transactionId: string,
  ): Promise<WagerTransaction> {
    const { operation } = command;
    const at = this.clock.now();

    if (command.inbox !== undefined) {
      const inserted = await tx.inbox.insertIfAbsent(
        this.inboxRow(command, hash, transactionId, at),
      );
      if (!inserted) {
        // A concurrent delivery of this message committed while we waited.
        const delivery = await tx.inbox.find(
          command.inbox.consumerName,
          command.inbox.messageId,
        );
        if (delivery === null) {
          throw new Error('the inbox insert conflicted with no stored row');
        }
        throw new AlreadyStored(
          await this.delivered(tx, delivery, command, hash),
        );
      }
    }

    // D1.
    const wallet = await tx.wallets.lock(operation.walletId, 'wait');
    if (wallet === null) throw new WalletNotFound(operation.walletId);

    // Another channel may have committed it since the unlocked lookup.
    const stored = await this.identify(tx, command, hash);
    if (stored !== null) {
      throw new AlreadyStored({ transaction: stored, duplicate: false });
    }

    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId: operation.providerId,
      externalTransactionId: operation.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: operation.walletId,
      playerId: operation.playerId,
      roundId: operation.roundId,
      gameId: operation.gameId,
      kind: operation.kind,
      money: Money.from(operation.money),
      ...(operation.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              operation.referenceExternalTransactionId,
          }),
      correlationId: command.correlationId,
      at,
    });
    const resolved = await resolveReference(tx, transaction);
    const decision = settle({
      transaction,
      wallet,
      ...resolved,
      ttlReached: false,
    });
    await applyOutcome(tx, transaction, wallet, decision, {
      ids: this.ids,
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: at,
      referenceTtlMs: this.settings.referenceTtlMs,
      ...(resolved.reference === null
        ? {}
        : { referenceTransactionId: resolved.reference.id }),
    });
    return transaction;
  }

  /**
   * The §8 decision table: the stored operation for a replay, null to
   * proceed, or a conflict.
   *
   * The two reads are separate statements, and without the wallet lock
   * another submission can commit between them. A row found by external ID
   * that carries this key is the row the key read missed, so the key rule
   * decides it, not the external-ID rule.
   */
  private async identify(
    tx: TxContext,
    command: SubmitCommand,
    hash: string,
  ): Promise<WagerTransaction | null> {
    const { providerId, externalTransactionId } = command.operation;
    const stored =
      (await tx.transactions.findByKey(providerId, command.idempotencyKey)) ??
      (await tx.transactions.findByExternalId(
        providerId,
        externalTransactionId,
      ));
    if (stored === null) return null;
    if (stored.idempotencyKey !== command.idempotencyKey) {
      this.telemetry.idempotencyConflict('EXTERNAL_TRANSACTION_ID_CONFLICT');
      throw new ExternalTransactionIdConflict();
    }
    if (stored.matchesPayload(hash)) return stored;
    this.telemetry.idempotencyConflict('IDEMPOTENCY_KEY_CONFLICT');
    throw new IdempotencyKeyConflict();
  }

  /** A stored inbox row: the same operation is a duplicate delivery, another one a conflict. */
  private async delivered(
    tx: TxContext,
    delivery: InboxMessage,
    command: SubmitCommand,
    hash: string,
  ): Promise<Found> {
    if (!delivery.matches(hash, command.idempotencyKey)) {
      throw new MessageIdConflict(delivery.messageId);
    }
    const transaction = await tx.transactions.findById(delivery.transactionId);
    if (transaction === null) {
      throw new Error(
        `inbox message ${delivery.messageId} points to no transaction`,
      );
    }
    return { transaction, duplicate: true };
  }

  /** Step 3: after an identity race, the committed winner decides. */
  private async reread(
    command: SubmitCommand,
    hash: string,
    race: IdentityRaceError,
  ): Promise<Found> {
    const winner = await this.unitOfWork.run(
      (tx) => this.identify(tx, command, hash),
      { retryContention: command.channel === 'http' },
    );
    if (winner === null) {
      throw new Error(
        `the ${race.constraint} race left no stored operation to replay`,
        { cause: race },
      );
    }
    return { transaction: winner, duplicate: false };
  }

  /** Answers a stored operation; an SQS replay first records its delivery. */
  private async answer(
    command: SubmitCommand,
    hash: string,
    found: Found,
    started: number,
  ): Promise<SubmitResult> {
    let duplicate = found.duplicate;
    if (command.inbox !== undefined && !duplicate) {
      duplicate = await this.recordDelivery(
        command,
        hash,
        found.transaction.id,
      );
    }
    if (!duplicate) this.telemetry.idempotentReplay(command.channel);
    this.finish(command.channel, started);
    return {
      transaction: toTransactionView(found.transaction),
      replay: true,
      duplicate,
    };
  }

  /**
   * The short SQS replay transaction (§10): records this delivery against
   * the stored operation. True when a concurrent delivery recorded it first.
   */
  private recordDelivery(
    command: SubmitCommand,
    hash: string,
    transactionId: string,
  ): Promise<boolean> {
    const { inbox } = command;
    if (inbox === undefined) return Promise.resolve(false);
    return this.unitOfWork.run(
      async (tx) => {
        const inserted = await tx.inbox.insertIfAbsent(
          this.inboxRow(command, hash, transactionId, this.clock.now()),
        );
        if (inserted) return false;
        const delivery = await tx.inbox.find(
          inbox.consumerName,
          inbox.messageId,
        );
        if (delivery === null) {
          throw new Error('the inbox insert conflicted with no stored row');
        }
        await this.delivered(tx, delivery, command, hash);
        return true;
      },
      { retryContention: false },
    );
  }

  private inboxRow(
    command: SubmitCommand,
    hash: string,
    transactionId: string,
    at: Date,
  ): InboxMessage {
    const { inbox } = command;
    if (inbox === undefined) throw new Error('not an SQS delivery');
    return InboxMessage.receive({
      consumerName: inbox.consumerName,
      messageId: inbox.messageId,
      payloadHash: hash,
      idempotencyKey: command.idempotencyKey,
      transactionId,
      at,
    });
  }

  private finish(channel: SubmitCommand['channel'], started: number): void {
    this.telemetry.processingDuration(
      channel,
      (performance.now() - started) / 1000,
    );
  }

  /** D9: a settlement against a reversed `BET` is processed, and flagged. */
  private warnIfReversed(transaction: WagerTransaction): void {
    const reversedBy = transaction.resultDetails?.referenceReversedBy;
    if (reversedBy === undefined) return;
    this.logger.warn('settled against a reversed reference', {
      transactionId: transaction.id,
      kind: transaction.kind,
      referenceReversedBy: reversedBy,
    });
  }
}
