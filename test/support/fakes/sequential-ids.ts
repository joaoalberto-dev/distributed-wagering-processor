import type { IdGenerator } from '../../../src/application/ports/id-generator.js';

/** Predictable, well-formed, increasing UUIDs: `00000000-0000-7000-8000-000000000001`, … */
export class SequentialIds implements IdGenerator {
  #next = 1;

  uuidv7(): string {
    const n = (this.#next++).toString(16).padStart(12, '0');
    return `00000000-0000-7000-8000-${n}`;
  }
}
