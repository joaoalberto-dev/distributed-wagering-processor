import type { IdGenerator } from '../../application/ports/id-generator.js';

export class UuidV7Generator implements IdGenerator {
  uuidv7(): string {
    return Bun.randomUUIDv7();
  }
}
