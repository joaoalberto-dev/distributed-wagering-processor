import { waitFor } from './wait-for.js';

export type HttpResponse<T = unknown> = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
};

export type RequestOptions = {
  readonly headers?: Record<string, string>;
  /** Resend a 503 with the same request until another status or the deadline. */
  readonly retryUnavailableMs?: number;
};

/**
 * A small JSON client for one spawned instance. A 503 means "safe to resend
 * with the same key", so callers that need an outcome opt into resending it.
 */
export class HttpClient {
  constructor(readonly baseUrl: string) {}

  get<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    const send = async (): Promise<HttpResponse<T>> => {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      const text = await response.text();
      const type = response.headers.get('content-type') ?? '';
      return {
        status: response.status,
        headers: response.headers,
        body: (type.includes('json') && text !== ''
          ? JSON.parse(text)
          : text) as T,
      };
    };
    if (options.retryUnavailableMs === undefined) return send();
    let last: HttpResponse<T> | undefined;
    try {
      return await waitFor(
        async () => {
          last = await send();
          return last.status === 503 ? undefined : last;
        },
        {
          timeoutMs: options.retryUnavailableMs,
          intervalMs: 100,
          description: `${method} ${path} to stop answering 503`,
        },
      );
    } catch (error) {
      if (last !== undefined) return last;
      throw error;
    }
  }
}
