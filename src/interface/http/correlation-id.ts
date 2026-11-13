import type { RequestContext } from '../../application/ports/request-context.js';

/**
 * The correlation ID of the request in progress. `RequestContextMiddleware`
 * opens a context with one for every request, so its absence is a wiring bug.
 */
export function correlationIdOf(context: RequestContext): string {
  const { correlationId } = context.get();
  if (correlationId === undefined) {
    throw new Error('the request context has no correlation ID');
  }
  return correlationId;
}
