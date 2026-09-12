/** OpenAI-compatible error envelope. Ported from providers/errors.go. */

import type { ServerResponse } from 'node:http';
import { Cause, Data, Effect } from 'effect';

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

// ---------------------------------------------------------------------------
// Effect foundation: one Data.TaggedError per ErrorType.
//
// New Effect code should fail with these (they compose with Effect.catchTag,
// Effect.retry filters, etc.). Everything below the line — ApiError,
// asApiError, statusCodeForError, writeError — stays as the compatibility shim
// so clusters that have not migrated yet keep throwing/catching ApiError.
// ---------------------------------------------------------------------------

interface TaggedFields {
  readonly message: string;
  readonly code?: string;
  readonly param?: string;
  readonly status?: number;
}

export class InvalidRequestError extends Data.TaggedError('InvalidRequestError')<TaggedFields> {}
export class AuthenticationError extends Data.TaggedError('AuthenticationError')<TaggedFields> {}
export class PermissionError extends Data.TaggedError('PermissionError')<TaggedFields> {}
export class NotFoundError extends Data.TaggedError('NotFoundError')<TaggedFields> {}
export class RateLimitError extends Data.TaggedError('RateLimitError')<TaggedFields> {}
export class ServerError extends Data.TaggedError('ServerError')<TaggedFields> {}
export class ServiceUnavailableError extends Data.TaggedError('ServiceUnavailableError')<TaggedFields> {}

export type ProviderError =
  | InvalidRequestError
  | AuthenticationError
  | PermissionError
  | NotFoundError
  | RateLimitError
  | ServerError
  | ServiceUnavailableError;

const taggedForType = {
  [ErrorType.InvalidRequest]: InvalidRequestError,
  [ErrorType.Authentication]: AuthenticationError,
  [ErrorType.Permission]: PermissionError,
  [ErrorType.NotFound]: NotFoundError,
  [ErrorType.RateLimit]: RateLimitError,
  [ErrorType.Server]: ServerError,
  [ErrorType.ServiceUnavailable]: ServiceUnavailableError,
} as const;

/** Lifts an ApiError into the matching TaggedError. */
export function toTaggedError(err: ApiError): ProviderError {
  const fields = { message: err.message, code: err.code, param: err.param, status: err.status };
  switch (err.type) {
    case ErrorType.InvalidRequest:
      return new InvalidRequestError(fields);
    case ErrorType.Authentication:
      return new AuthenticationError(fields);
    case ErrorType.Permission:
      return new PermissionError(fields);
    case ErrorType.NotFound:
      return new NotFoundError(fields);
    case ErrorType.RateLimit:
      return new RateLimitError(fields);
    case ErrorType.ServiceUnavailable:
      return new ServiceUnavailableError(fields);
    default:
      return new ServerError(fields);
  }
}

/** Lowers any TaggedError (or ApiError) back to the ApiError wire shape. */
export function toApiError(err: ProviderError | ApiError): ApiError {
  if (err instanceof ApiError) return err;
  const type = taggedTypeOf(err);
  return new ApiError(err.message, type, err.code, err.param, err.status);
}

function taggedTypeOf(err: ProviderError): ErrorTypeValue {
  switch (err._tag) {
    case 'InvalidRequestError':
      return ErrorType.InvalidRequest;
    case 'AuthenticationError':
      return ErrorType.Authentication;
    case 'PermissionError':
      return ErrorType.Permission;
    case 'NotFoundError':
      return ErrorType.NotFound;
    case 'RateLimitError':
      return ErrorType.RateLimit;
    case 'ServiceUnavailableError':
      return ErrorType.ServiceUnavailable;
    default:
      return ErrorType.Server;
  }
}

void taggedForType;

/** Builds the matching TaggedError as an Effect failure. */
export function failEffect(
  type: ErrorTypeValue,
  message: string,
  extra?: { code?: string; param?: string; status?: number },
): Effect.Effect<never, ProviderError> {
  return Effect.fail(toTaggedError(new ApiError(message, type, extra?.code, extra?.param, extra?.status)));
}

// ---------------------------------------------------------------------------
// Promise boundary helpers.
//
// Effect.runPromise / Effect.runSync reject with a FiberFailure wrapper, which
// would break every `instanceof ApiError` check at the call sites. These run
// the Effect and rethrow the typed failure raw, so the public Promise/async
// surface keeps throwing exactly what it threw before the migration.
// ---------------------------------------------------------------------------

/** Runs an Effect at the async boundary, rethrowing the failure value raw. */
export function runPromiseBoundary<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === 'Success') return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === 'Some') throw failure.value;
    throw Cause.squash(exit.cause);
  });
}

/** Sync version for the throw-compat shims (parseStreamChunk, serializers). */
export function runSyncBoundary<A, E>(effect: Effect.Effect<A, E>): A {
  const exit = Effect.runSyncExit(effect);
  if (exit._tag === 'Success') return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === 'Some') throw failure.value;
  throw Cause.squash(exit.cause);
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
  if (typeof err === 'object' && err !== null && '_tag' in err && 'message' in err) {
    // A ProviderError TaggedError: lower it to the wire shape.
    return toApiError(err as ProviderError);
  }
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
