import type { Clock } from '../../../src/application/ports/clock.js';

/** A clock that moves only when the test moves it. */
export class FixedClock implements Clock {
  #now: Date;

  constructor(start = new Date('2026-11-12T10:00:00.000Z')) {
    this.#now = start;
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}
