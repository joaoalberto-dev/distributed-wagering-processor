/** One outbox row as the broker sees it. */
export type PublishEntry = {
  /** The event's `eventId`: the deduplication ID downstream. */
  readonly id: string;
  /** The ordering group: the event's wallet. */
  readonly groupId: string;
  /** The serialized envelope. */
  readonly body: string;
};

/** What happened to one entry of a batch. */
export type PublishResult = {
  readonly id: string;
  readonly ok: boolean;
  /** The broker refused the entry itself (for example, a malformed body); a retry alone will not fix it. */
  readonly senderFault: boolean;
  /** A short reason for a failed entry, kept as the row's `last_error`. */
  readonly error?: string;
};

/**
 * Sends integration events (§13). A call either answers every entry, some
 * of which may have failed, or throws when the broker could not be reached
 * at all; a throw means no entry is known to be sent.
 */
export interface EventPublisher {
  publishBatch(entries: readonly PublishEntry[]): Promise<PublishResult[]>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
