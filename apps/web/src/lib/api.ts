import { isApiErrorBody, type ErrorCode } from '@avero/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  body?: unknown;
  /** Pass for retryable mutations; reuse the same key when retrying the same intent. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'avero' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'include',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', "You appear to be offline. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (isApiErrorBody(data)) {
      throw new ApiError(res.status, data.error.code, data.error.message, data.error.details, data.error.requestId);
    }
    throw new ApiError(res.status, 'INTERNAL', 'Something went wrong. Please try again.');
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, { signal }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}) =>
    request<T>('POST', path, { ...opts, body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export const newIdempotencyKey = () => crypto.randomUUID();

/** Field-level messages from a VALIDATION_FAILED error, keyed by field path. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return {};
  const out: Record<string, string> = {};
  for (const issue of (error.details as { path: string; message: string }[] | undefined) ?? []) {
    out[issue.path] ??= issue.message;
  }
  return out;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
