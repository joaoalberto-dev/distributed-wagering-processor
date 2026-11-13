import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BulkheadFullError } from '@nestjs/resilience';
import { lastValueFrom, of } from 'rxjs';
import { rejectionOf } from '../../test/support/rejection-of.js';
import type { RouteGroup } from '../application/ports/route-group.js';
import { HealthController } from '../infrastructure/observability/health.controller.js';
import { MetricsController } from '../infrastructure/observability/metrics.controller.js';
import { createPolicies } from '../infrastructure/resilience/policies.js';
import { WageringTransactionsController } from '../interface/http/wagering-transactions.controller.js';
import { WalletsController } from '../interface/http/wallets.controller.js';
import { BulkheadInterceptor, groupOf } from './bulkhead.interceptor.js';

const reflector = new Reflector();

function contextOf<T>(
  controller: abstract new (...args: never[]) => T,
  method: keyof T & string,
): ExecutionContext {
  const prototype = controller.prototype as Record<string, unknown>;
  return {
    getClass: () => controller,
    getHandler: () => prototype[method],
  } as unknown as ExecutionContext;
}

describe('groupOf', () => {
  it('reads each route group from the route metadata', () => {
    const cases: [ExecutionContext, RouteGroup][] = [
      [contextOf(HealthController, 'live'), 'none'],
      [contextOf(HealthController, 'ready'), 'readiness'],
      [contextOf(MetricsController, 'scrape'), 'metrics'],
      [contextOf(WalletsController, 'reconcile'), 'reconciliation'],
    ];
    for (const [context, group] of cases) {
      expect(groupOf(reflector, context)).toBe(group);
    }
  });

  it('puts a route that declares no group in http', () => {
    expect(groupOf(reflector, contextOf(WalletsController, 'open'))).toBe(
      'http',
    );
    expect(
      groupOf(reflector, contextOf(WageringTransactionsController, 'submit')),
    ).toBe('http');
  });
});

describe('BulkheadInterceptor', () => {
  const config = { http: { bulkheadSize: 1, bulkheadQueue: 0 } };

  it('lets readiness through while a /metrics scrape holds its share', async () => {
    const policies = createPolicies(config);
    const interceptor = new BulkheadInterceptor(policies, reflector);
    const scrape = Promise.withResolvers<void>();
    const holding = policies.bulkheads.metrics.execute(() => scrape.promise);

    const ready = await lastValueFrom(
      interceptor.intercept(contextOf(HealthController, 'ready'), {
        handle: () => of('ready'),
      }),
    );
    expect(ready).toBe('ready');

    scrape.resolve();
    await holding;
  });

  it('rejects a route once its group is full, and never bounds liveness', async () => {
    const policies = createPolicies(config);
    const interceptor = new BulkheadInterceptor(policies, reflector);
    const busy = Promise.withResolvers<void>();
    const holding = policies.bulkheads.http.execute(() => busy.promise);

    const refused = await rejectionOf(
      lastValueFrom(
        interceptor.intercept(contextOf(WalletsController, 'open'), {
          handle: () => of('opened'),
        }),
      ),
    );
    expect(refused).toBeInstanceOf(BulkheadFullError);

    const live = await lastValueFrom(
      interceptor.intercept(contextOf(HealthController, 'live'), {
        handle: () => of('live'),
      }),
    );
    expect(live).toBe('live');

    busy.resolve();
    await holding;
  });
});
