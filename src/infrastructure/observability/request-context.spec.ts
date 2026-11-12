import { describe, expect, it } from 'bun:test';
import { AsyncLocalRequestContext } from './request-context.js';

describe('AsyncLocalRequestContext', () => {
  it('carries fields across awaits and nests scopes', async () => {
    const context = new AsyncLocalRequestContext({ instanceId: 'i-1' });
    expect(context.get()).toEqual({ instanceId: 'i-1' });
    await context.run({ correlationId: 'c-1' }, async () => {
      await Bun.sleep(1);
      context.set({ walletId: 'w-1' });
      expect(context.get()).toEqual({
        instanceId: 'i-1',
        correlationId: 'c-1',
        walletId: 'w-1',
      });
      await context.run({ transactionId: 't-1' }, async () => {
        await Bun.sleep(1);
        expect(context.get()).toMatchObject({
          walletId: 'w-1',
          transactionId: 't-1',
        });
      });
      expect(context.get().transactionId).toBeUndefined();
    });
    expect(context.get()).toEqual({ instanceId: 'i-1' });
  });

  it('keeps concurrent scopes apart', async () => {
    const context = new AsyncLocalRequestContext();
    const seen = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        context.run({ requestId: id }, async () => {
          await Bun.sleep(Math.random() * 5);
          return context.get().requestId;
        }),
      ),
    );
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('ignores set outside any scope and undefined fields', async () => {
    const context = new AsyncLocalRequestContext();
    context.set({ walletId: 'w-1' });
    expect(context.get()).toEqual({});
    await context.run({ correlationId: undefined }, () => {
      expect('correlationId' in context.get()).toBe(false);
      return Promise.resolve();
    });
  });
});
