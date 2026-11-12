import type {
  TxContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from '../../../src/application/ports/unit-of-work.js';
import { InMemoryStore, inMemoryTxContext } from './in-memory-repositories.js';
import { FixedClock } from './fixed-clock.js';

/**
 * Runs each unit of work on a copy of the store and commits the copy only if
 * the callback returns and the unique constraints hold: all or nothing, like
 * the real one. Calls run one at a time.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  readonly store = new InMemoryStore();
  readonly runs: UnitOfWorkOptions[] = [];
  /** Runs before the commit of the next unit of work; for races and failures. */
  beforeCommit: ((store: InMemoryStore) => void) | undefined;

  constructor(readonly clock: FixedClock = new FixedClock()) {}

  async run<T>(
    fn: (tx: TxContext) => Promise<T>,
    options: UnitOfWorkOptions,
  ): Promise<T> {
    this.runs.push(options);
    const working = this.store.clone();
    const result = await fn(inMemoryTxContext(working, this.clock));
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    hook?.(working);
    working.assertConstraints();
    Object.assign(this.store, working);
    return result;
  }
}
