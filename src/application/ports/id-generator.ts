/** Generates the IDs of new aggregates and events. */
export interface IdGenerator {
  /** A lowercase UUIDv7: time-ordered, so new rows land at the end of their indexes. */
  uuidv7(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
