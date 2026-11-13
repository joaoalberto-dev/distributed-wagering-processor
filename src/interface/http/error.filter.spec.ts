import { describe, expect, it } from 'bun:test';
import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ErrorFilter } from './error.filter.js';

type Answer = {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
};

function answer(exception: unknown): Answer {
  const result: Answer = { headers: {} };
  const response = {
    setHeader(name: string, value: string) {
      result.headers[name] = value;
    },
    status(code: number) {
      result.status = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new ErrorFilter().catch(exception, host);
  return result;
}

describe('ErrorFilter', () => {
  it('names malformed JSON when the body parser failed', () => {
    const parsed = answer(
      new BadRequestException('Unexpected end of JSON input', {
        cause: new SyntaxError('Unexpected end of JSON input'),
      }),
    );
    expect(parsed.status).toBe(HttpStatus.BAD_REQUEST);
    expect(parsed.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'the request body is not valid JSON',
      },
    });
  });

  it('names the path, not the body, for a bad percent-encoding', () => {
    const path = answer(
      new BadRequestException('URI malformed', {
        cause: new URIError('URI malformed'),
      }),
    );
    expect(path.status).toBe(HttpStatus.BAD_REQUEST);
    expect(path.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'the request path is not valid',
      },
    });
  });

  it('keeps the message of any other 400', () => {
    const other = answer(new BadRequestException('the header is too long'));
    expect(other.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'the header is too long' },
    });
  });

  it('answers a 503 HttpException with Retry-After', () => {
    const unavailable = answer(
      new HttpException('down', HttpStatus.SERVICE_UNAVAILABLE),
    );
    expect(unavailable.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(unavailable.headers['Retry-After']).toBe('1');
  });
});
