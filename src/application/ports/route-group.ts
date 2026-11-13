/**
 * The share of the process a route driven from outside uses (connection
 * budget, §10). Each bulkhead group has its own bulkhead; `none` runs
 * outside any, for a route that touches no dependency and must answer even
 * when every share is full.
 */
export type BulkheadGroup = 'http' | 'reconciliation' | 'readiness' | 'metrics';

export type RouteGroup = BulkheadGroup | 'none';

/**
 * The route metadata key that names a handler's group, set with
 * `@SetMetadata(ROUTE_GROUP, group)` on the handler or its controller. A
 * route that sets none is in `http`.
 */
export const ROUTE_GROUP = 'wagering:route-group';
