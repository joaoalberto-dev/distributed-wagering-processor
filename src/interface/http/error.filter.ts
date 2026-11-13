import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ResilienceError } from '@nestjs/resilience';
import type { Response } from 'express';
import {
  ContentionError,
  ExternalTransactionIdConflict,
  IdempotencyKeyConflict,
  InvalidCursor,
  OutageError,
  TransactionNotFound,
  ValidationFailed,
  WalletAlreadyExists,
  WalletNotFound,
} from '../../application/errors.js';

/** `{ "error": { "code", "message", "details?" } }` (§7). */
export type ErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
};

type Mapped = {
  readonly status: number;
  readonly body: ErrorBody | object;
};

const envelope = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorBody => ({
  error: details === undefined ? { code, message } : { code, message, details },
});

const UNAVAILABLE = envelope(
  'SERVICE_UNAVAILABLE',
  'the service is temporarily unavailable; resending with the same key is safe',
);

/** The application errors and their HTTP form (§6). */
function mapApplicationError(error: unknown): Mapped | null {
  if (error instanceof ValidationFailed) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: envelope(error.code, error.message, { issues: error.issues }),
    };
  }
  if (error instanceof InvalidCursor) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: envelope(error.code, error.message),
    };
  }
  if (error instanceof WalletNotFound || error instanceof TransactionNotFound) {
    return {
      status: HttpStatus.NOT_FOUND,
      body: envelope(error.code, error.message),
    };
  }
  if (error instanceof WalletAlreadyExists) {
    return {
      status: HttpStatus.CONFLICT,
      body: envelope(
        error.code,
        error.message,
        error.walletId === undefined ? undefined : { walletId: error.walletId },
      ),
    };
  }
  if (
    error instanceof IdempotencyKeyConflict ||
    error instanceof ExternalTransactionIdConflict
  ) {
    return {
      status: HttpStatus.CONFLICT,
      body: envelope(error.code, error.message),
    };
  }
  if (error instanceof ContentionError || error instanceof OutageError) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, body: UNAVAILABLE };
  }
  return null;
}

function mapHttpException(exception: HttpException): Mapped {
  const status = exception.getStatus();
  const response = exception.getResponse();
  // Terminus answers readiness with its own body, which names the failing check.
  if (
    typeof response === 'object' &&
    'status' in response &&
    'info' in response
  ) {
    return { status, body: response };
  }
  // The Express adapter wraps the body parser's `SyntaxError` and the router's
  // `URIError` (a bad percent-encoding in the path) as 400s: neither reaches a
  // schema. Any other 400 keeps its own message.
  if (exception.cause instanceof SyntaxError) {
    return {
      status,
      body: envelope('VALIDATION_FAILED', 'the request body is not valid JSON'),
    };
  }
  if (exception.cause instanceof URIError) {
    return {
      status,
      body: envelope('VALIDATION_FAILED', 'the request path is not valid'),
    };
  }
  if (status === HttpStatus.BAD_REQUEST) {
    return {
      status,
      body: envelope('VALIDATION_FAILED', exception.message),
    };
  }
  if (status === HttpStatus.NOT_FOUND) {
    return { status, body: envelope('NOT_FOUND', 'no such route') };
  }
  return {
    status,
    body: envelope(
      status === HttpStatus.SERVICE_UNAVAILABLE
        ? 'SERVICE_UNAVAILABLE'
        : `HTTP_${status}`,
      exception.message,
    ),
  };
}

/**
 * Maps every error to the §6 and §7 contract: application errors by class,
 * bulkhead and circuit rejections to 503, anything unknown to
 * `500 INTERNAL_ERROR`. Every 503 carries `Retry-After: 1`.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = this.map(exception);
    if (mapped.status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
    }
    response.status(mapped.status).json(mapped.body);
  }

  private map(exception: unknown): Mapped {
    const mapped = mapApplicationError(exception);
    if (mapped !== null) return mapped;
    if (exception instanceof ResilienceError) {
      return { status: HttpStatus.SERVICE_UNAVAILABLE, body: UNAVAILABLE };
    }
    if (exception instanceof HttpException) return mapHttpException(exception);
    this.#logger.error('unexpected error', exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: envelope(
        'INTERNAL_ERROR',
        'unexpected error; resending with the same key is safe',
      ),
    };
  }
}
