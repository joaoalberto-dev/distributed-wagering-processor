import type { Clock } from '../../application/ports/clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
