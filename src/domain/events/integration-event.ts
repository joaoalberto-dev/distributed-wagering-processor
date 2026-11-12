export type IntegrationEventProps<T> = {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
};

/** What the caller supplies for each event: its ID, tracing, and time. */
export type EventContext = Omit<
  IntegrationEventProps<unknown>,
  'aggregateId' | 'data'
>;

/** The serialized envelope written to the outbox payload. */
export type IntegrationEventJSON<T> = {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  /** ISO-8601. */
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The envelope of every integration event. Each subclass fixes its
 * `eventType` and `version` in the type, and `data` carries money as
 * `MoneyProps`, so the payload is stable, versionable JSON.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = deepFreeze(props.data);
  }

  toJSON(): IntegrationEventJSON<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined
        ? {}
        : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
