/** The application clock, for domain timestamps only; scheduling uses the database clock. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
