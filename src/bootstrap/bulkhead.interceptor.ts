import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import {
  ROUTE_GROUP,
  type RouteGroup,
} from '../application/ports/route-group.js';
import type { Policies } from '../infrastructure/resilience/policies.js';

/**
 * The route group of a handler (connection budget, §10): the `ROUTE_GROUP`
 * metadata of the handler, else of its controller, else `http`.
 */
export function groupOf(
  reflector: Reflector,
  context: ExecutionContext,
): RouteGroup {
  return (
    reflector.getAllAndOverride<RouteGroup | undefined>(ROUTE_GROUP, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'http'
  );
}

/**
 * Runs each handler inside its group's bulkhead, so controllers import no
 * resilience policy. A full bulkhead rejects with `BulkheadFullError`, which
 * the error filter answers with 503 and `Retry-After: 1`.
 */
export class BulkheadInterceptor implements NestInterceptor {
  constructor(
    private readonly policies: Policies,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const group = groupOf(this.reflector, context);
    if (group === 'none') return next.handle();
    const bulkhead = this.policies.bulkheads[group];
    return from(bulkhead.execute(() => lastValueFrom(next.handle())));
  }
}
