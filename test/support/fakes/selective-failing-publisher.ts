import type {
  EventPublisher,
  PublishEntry,
  PublishResult,
} from '../../../src/application/ports/event-publisher.js';

/** The failures of one future call. */
export type PlannedFailure =
  /** The whole call throws; nothing is sent. */
  | { readonly kind: 'call'; readonly error: Error }
  /** These 1-based positions of the batch fail; the rest are sent. */
  | {
      readonly kind: 'entries';
      readonly positions: readonly number[];
      readonly senderFault?: boolean;
    };

/**
 * A publisher that fails what a test plans and sends the rest through
 * `inner` (the real adapter in integration specs; nothing, and always
 * successful, in unit specs). It records every call's entries, and can hold
 * each call for `delayMs`, so concurrent cycles overlap.
 */
export class SelectiveFailingPublisher implements EventPublisher {
  /** The entries of every call, in order, including failed ones. */
  readonly calls: PublishEntry[][] = [];
  readonly #plan: PlannedFailure[] = [];

  constructor(
    private readonly inner?: EventPublisher,
    private readonly delayMs = 0,
  ) {}

  /** Plans the failures of the next call that has none planned yet. */
  failNext(failure: PlannedFailure): void {
    this.#plan.push(failure);
  }

  /** The IDs of every entry of every call. */
  sentIds(): string[] {
    return this.calls.flat().map((entry) => entry.id);
  }

  async publishBatch(
    entries: readonly PublishEntry[],
  ): Promise<PublishResult[]> {
    this.calls.push([...entries]);
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    const failure = this.#plan.shift();
    if (failure?.kind === 'call') throw failure.error;

    const failed = new Set(
      failure?.kind === 'entries'
        ? failure.positions.map((p) => entries[p - 1]?.id)
        : [],
    );
    const forwarded = entries.filter((entry) => !failed.has(entry.id));
    const sent =
      this.inner === undefined || forwarded.length === 0
        ? forwarded.map((entry) => ({
            id: entry.id,
            ok: true,
            senderFault: false,
          }))
        : await this.inner.publishBatch(forwarded);
    const byId = new Map(sent.map((result) => [result.id, result]));
    return entries.map(
      (entry) =>
        byId.get(entry.id) ?? {
          id: entry.id,
          ok: false,
          senderFault:
            failure?.kind === 'entries' && failure.senderFault === true,
          error: 'InjectedFailure',
        },
    );
  }
}
