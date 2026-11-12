import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { JsonLogger, NestAppLogger } from './json-logger.js';
import { AsyncLocalRequestContext } from './request-context.js';

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

function captureStdout(): string[] {
  const lines: string[] = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  restore.push(() => spy.mockRestore());
  return lines;
}

describe('JsonLogger', () => {
  it('writes one JSON line with the context IDs at the root', async () => {
    const context = new AsyncLocalRequestContext({ instanceId: 'i-1' });
    const logger = new JsonLogger(context, ['log', 'warn']);
    const lines = captureStdout();
    await context.run({ correlationId: 'c-1', requestId: 'r-1' }, () => {
      logger.log('hello', 'Spec');
      return Promise.resolve();
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'log',
      message: 'hello',
      context: 'Spec',
      instanceId: 'i-1',
      correlationId: 'c-1',
      requestId: 'r-1',
    });
  });

  it('flattens the fields of the application logger', () => {
    const context = new AsyncLocalRequestContext({ instanceId: 'i-1' });
    const logger = new JsonLogger(context, ['warn']);
    const lines = captureStdout();
    new NestAppLogger(logger, 'Reconciliation').warn('diverged', {
      walletId: 'w-1',
      issues: ['BALANCE_MISMATCH'],
    });
    const record = JSON.parse([...lines].join('') || '{}') as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: 'warn',
      message: 'diverged',
      context: 'Reconciliation',
      walletId: 'w-1',
      issues: ['BALANCE_MISMATCH'],
      instanceId: 'i-1',
    });
  });
});
