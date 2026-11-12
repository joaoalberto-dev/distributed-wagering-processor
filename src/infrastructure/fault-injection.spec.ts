import { describe, expect, it } from 'bun:test';
import { rejectionOf } from '../../test/support/rejection-of.js';
import type {
  SubmitCommand,
  SubmitResult,
} from '../application/wagering/submit-wager-transaction.js';
import { FaultInjection, InjectedFault } from './fault-injection.js';

const WALLET = 'aaaaaaaa-0000-7000-8000-000000000000';
const OTHER = 'aaaaaaaa-0000-7000-8000-000000000001';

const crashes: string[] = [];
const recordCrash = (): never => {
  crashes.push('crash');
  throw new Error('crashed');
};

const command = (walletId: string) =>
  ({ operation: { walletId } }) as unknown as SubmitCommand;

const submitter = {
  execute: () => Promise.resolve({ replay: false } as SubmitResult),
};

describe('FaultInjection', () => {
  it('does nothing without fault points', async () => {
    const faults = new FaultInjection([], recordCrash);
    faults.crashAfterCommit();
    faults.crashAfterSend();
    expect(faults.wrapSubmitter(submitter)).toBe(submitter);
    expect(faults.enabled).toBe(false);
    expect(crashes).toEqual([]);
    await faults.wrapSubmitter(submitter).execute(command(WALLET));
  });

  it('crashes at the configured point only', () => {
    crashes.length = 0;
    const faults = new FaultInjection(['crash-after-commit'], recordCrash);
    faults.crashAfterSend();
    expect(crashes).toEqual([]);
    expect(() => faults.crashAfterCommit()).toThrow('crashed');
    expect(crashes).toEqual(['crash']);
  });

  it('fails submissions for the configured wallet only', async () => {
    const faults = new FaultInjection([
      `unexpected-on-wallet:${WALLET.toUpperCase()}`,
    ]);
    const wrapped = faults.wrapSubmitter(submitter);
    expect(await rejectionOf(wrapped.execute(command(WALLET)))).toBeInstanceOf(
      InjectedFault,
    );
    expect(await wrapped.execute(command(OTHER))).toEqual({
      replay: false,
    } as SubmitResult);
  });
});
