import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * One request header, by name, as a route argument that takes a schema:
 * `@RequestHeader('idempotency-key', { schema })`. Nest's `@Headers` accepts
 * neither a schema nor pipes. An absent header is `undefined`, so a required
 * header fails its schema.
 */
export const RequestHeader = createParamDecorator(
  (name: string, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<Request>().header(name),
);
