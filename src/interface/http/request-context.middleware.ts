import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../../application/ports/id-generator.js';
import {
  REQUEST_CONTEXT,
  type RequestContext,
} from '../../application/ports/request-context.js';
import { externalId } from '../../contracts/primitives.js';

/**
 * Opens the request context for the whole request: a new `X-Request-Id`,
 * and the incoming `X-Correlation-Id` when it is 1–128 of `[A-Za-z0-9._:-]`,
 * otherwise a new one. Both are echoed in the response headers.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly context: RequestContext,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = this.ids.uuidv7();
    const incoming = request.header('x-correlation-id');
    const correlationId = externalId.safeParse(incoming).success
      ? (incoming as string)
      : this.ids.uuidv7();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Correlation-Id', correlationId);
    // The scope lasts until the response closes; `next()` runs inside it.
    this.context
      .run(
        { requestId, correlationId },
        () =>
          new Promise<void>((resolve) => {
            response.once('close', resolve);
            next();
          }),
      )
      .catch(next);
  }
}
