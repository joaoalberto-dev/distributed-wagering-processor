import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { HealthController } from '../infrastructure/observability/health.controller.js';
import { MetricsController } from '../infrastructure/observability/metrics.controller.js';
import type {
  BulkheadGroup,
  Policies,
} from '../infrastructure/resilience/policies.js';
import { WalletsController } from '../interface/http/wallets.controller.js';

/**
 * The route group of a handler (connection budget, §10). Liveness has no
 * group: it touches no dependency and must answer even when every share is
 * full.
 */
export function groupOf(
  controller: unknown,
  handler: unknown,
): BulkheadGroup | null {
  if (controller === HealthController) {
    return handler === HealthController.prototype.ready ? 'readiness' : null;
  }
  if (controller === MetricsController) return 'readiness';
  if (
    controller === WalletsController &&
    handler === WalletsController.prototype.reconcile
  ) {
    return 'reconciliation';
  }
  return 'http';
}

/**
 * Runs each handler inside its group's bulkhead, so controllers import no
 * resilience policy. A full bulkhead rejects with `BulkheadFullError`, which
 * the error filter answers with 503 and `Retry-After: 1`.
 */
export class BulkheadInterceptor implements NestInterceptor {
  constructor(private readonly policies: Policies) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const group = groupOf(context.getClass(), context.getHandler());
    if (group === null) return next.handle();
    const bulkhead = this.policies.bulkheads[group];
    return from(bulkhead.execute(() => lastValueFrom(next.handle())));
  }
}
