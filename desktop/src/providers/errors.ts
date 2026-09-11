/** OpenAI-compatible error envelope. Ported from providers/errors.go. */

import type { ServerResponse } from 'node:http';

export const ErrorType = {
  InvalidRequest: 'invalid_request_error',
  Authentication: 'authentication_error',
  Permission: 'permission_error',
  NotFound: 'not_found_error',
  RateLimit: 'rate_limit_error',
  Server: 'server_error',
  ServiceUnavailable: 'service_unavailable',
} as const;

export type ErrorTypeValue = (typeof ErrorType)[keyof typeof ErrorType];

/**
 * Carries the OpenAI error shape while still being a real Error, so it can be
 * thrown and caught like any other failure. `toJSON` keeps `JSON.stringify`
 * emitting the wire shape rather than an empty object.
 */
export class ApiError extends Error {
  readonly type: ErrorTypeValue;
  readonly param?: string;
  readonly code?: string;
  /**
   * The upstream HTTP status, when the error came from a response rather than
   * from us. Kept off `toJSON` so the wire shape stays the OpenAI envelope; it
   * is for callers deciding whether a failure is worth retrying differently.
   */
  readonly status?: number;

  constructor(message: string, type: ErrorTypeValue, code?: string, param?: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.code = code;
    this.param = param;
    this.status = status;
  }

  toJSON() {
    return { message: this.message, type: this.type, param: this.param, code: this.code };
  }
}

export const errInvalidJson = () => new ApiError('invalid JSON in request body', ErrorType.InvalidRequest);
export const errModelRequired = () => new ApiError('model is required', ErrorType.InvalidRequest);
export const errMessagesRequired = () => new ApiError('messages is required', ErrorType.InvalidRequest);
export const errUnauthorized = () => new ApiError('invalid API key', ErrorType.Authentication);

export const errModelNotFound = (model: string) =>
  new ApiError(`model '${model}' not found`, ErrorType.NotFound);
export const errProviderNotConfigured = (provider: string) =>
  new ApiError(`provider '${provider}' is not configured`, ErrorType.InvalidRequest);
export const errProviderError = (message: string) => new ApiError(message, ErrorType.Server);
export const errRateLimit = (message: string) => new ApiError(message, ErrorType.RateLimit);

/** Wraps an unknown thrown value as an ApiError without losing its message. */
export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return errProviderError(err instanceof Error ? err.message : String(err));
}

export function statusCodeForError(type: string): number {
  switch (type) {
    case ErrorType.InvalidRequest:
      return 400;
    case ErrorType.Authentication:
      return 401;
    case ErrorType.Permission:
      return 403;
    case ErrorType.NotFound:
      return 404;
    case ErrorType.RateLimit:
      return 429;
    case ErrorType.ServiceUnavailable:
      return 503;
    default:
      return 500;
  }
}

export function writeError(res: ServerResponse, err: ApiError, statusCode?: number): void {
  res.writeHead(statusCode ?? statusCodeForError(err.type), { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: err }));
}
