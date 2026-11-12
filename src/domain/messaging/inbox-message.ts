export type InboxMessageState = {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
  readonly transactionId: string;
  readonly receivedAt: Date;
  readonly processedAt: Date;
};

/**
 * One SQS delivery, identified by `(consumerName, envelope messageId)`. It is
 * written in the same SQL transaction as the effect, so it is processed when
 * it exists.
 */
export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  static receive(props: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
    idempotencyKey: string;
    transactionId: string;
    at: Date;
  }): InboxMessage {
    return new InboxMessage({
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
      idempotencyKey: props.idempotencyKey,
      transactionId: props.transactionId,
      receivedAt: props.at,
      processedAt: props.at,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({ ...state });
  }

  get consumerName(): string {
    return this.state.consumerName;
  }
  get messageId(): string {
    return this.state.messageId;
  }
  get payloadHash(): string {
    return this.state.payloadHash;
  }
  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }
  get transactionId(): string {
    return this.state.transactionId;
  }
  get receivedAt(): Date {
    return this.state.receivedAt;
  }
  get processedAt(): Date {
    return this.state.processedAt;
  }

  /**
   * The same pair is a duplicate delivery. A different pair under the same
   * `messageId` is `MESSAGE_ID_CONFLICT`.
   */
  matches(payloadHash: string, idempotencyKey: string): boolean {
    return (
      this.state.payloadHash === payloadHash &&
      this.state.idempotencyKey === idempotencyKey
    );
  }

  toState(): InboxMessageState {
    return { ...this.state };
  }
}
