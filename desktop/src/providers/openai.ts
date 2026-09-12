/** OpenAI provider. Ported from providers/openai.go. */

import { Effect, Schedule, Stream } from 'effect';
import { ApiError, ErrorType, asApiError, runPromiseBoundary, type ErrorTypeValue } from './errors.js';
import { parseStreamChunkEffect, readSseDataStream } from './streaming.js';
import { serializeRequest } from './wire.js';
import { withEstimatedUsageCost } from './pricing.js';
import type { Provider } from './provider.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Model,
  ModelsResponse,
  StreamChunk,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';

/** Cap for a single upstream call; the caller's AbortSignal still wins first. */
const UPSTREAM_TIMEOUT = '30 seconds' as const;
/** Transient transport failures get two spaced retries; HTTP errors do not. */
const upstreamRetrySchedule = Schedule.intersect(Schedule.exponential('200 millis'), Schedule.recurs(2));

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Only transport-level failures are worth retrying; HTTP statuses (already an
 * ApiError via parseError) and aborts are final.
 */
function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (isAbortLike(err)) return false;
  if ((err as { _tag?: string })?._tag === 'TimeoutException') return false;
  return err instanceof TypeError;
}

function mapTimeout(err: unknown): unknown {
  if ((err as { _tag?: string })?._tag === 'TimeoutException') {
    return new ApiError('upstream request timed out', ErrorType.Server);
  }
  return err;
}

/**
 * fetch wrapped as an interruptible Effect: Effect.timeout bounds the call,
 * Effect.retry replays transient transport failures, and the Effect runtime's
 * own AbortSignal is combined with the caller's so either side aborts the
 * request (abort via Effect interrupt). Transport errors stay raw — callers
 * above (failover, plugin fallback) classify them by shape, exactly as before.
 */
function fetchUpstreamEffect(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  outerSignal?: AbortSignal,
): Effect.Effect<Response, unknown> {
  const attempt = Effect.tryPromise({
    try: (abortSignal) =>
      fetchImpl(url, {
        ...init,
        signal: outerSignal ? AbortSignal.any([outerSignal, abortSignal]) : abortSignal,
      }),
    catch: (err) => err,
  }).pipe(
    Effect.timeout(UPSTREAM_TIMEOUT),
    Effect.catchAll((err) => Effect.fail(mapTimeout(err))),
  );
  return Effect.retry(attempt, { schedule: upstreamRetrySchedule, while: isRetryableFetchError });
}

function runFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  outerSignal?: AbortSignal,
): Promise<Response> {
  return runPromiseBoundary(fetchUpstreamEffect(fetchImpl, url, init, outerSignal));
}

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  /** Path between the provider base URL and OpenAI-compatible resource names. */
  apiPrefix?: string;
  /** Injected for tests and for providers that tunnel through a proxy. */
  fetchImpl?: typeof fetch;
}

export class OpenAiProvider implements Provider {
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly apiPrefix: string;

  constructor(options: OpenAiOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.apiPrefix = options.apiPrefix ?? '/v1';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Overridden by OpenRouter, which adds attribution headers. */
  protected headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async chatCompletion(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const program = Effect.gen(this, function* () {
      const res = yield* fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}${this.apiPrefix}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: serializeRequest(req, false),
      }, signal);

      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (err) => err,
      });

      if (!res.ok) return yield* Effect.fail(this.parseError(res.status, text));

      const result = yield* Effect.try({
        try: () => JSON.parse(text) as ChatCompletionResponse,
        catch: (err) =>
          new ApiError(
            `failed to unmarshal response: ${err instanceof Error ? err.message : String(err)}`,
            ErrorType.Server,
          ),
      });
      return { ...result, usage: withEstimatedUsageCost(this.baseUrl, req.model, result.usage) };
    });
    return runPromiseBoundary(program);
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const res = await runFetch(
      this.fetchImpl,
      `${this.baseUrl}${this.apiPrefix}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers({ Accept: 'text/event-stream' }),
        body: serializeRequest(req, true),
      },
      signal,
    );

    if (!res.ok) throw this.parseError(res.status, await res.text());
    if (!res.body) throw new ApiError('upstream returned no body', ErrorType.Server);

    // Stream through the Effect Stream; parse each payload via its Effect so a
    // mid-stream error envelope fails the iteration instead of yielding junk.
    const parsed = Stream.mapEffect(readSseDataStream(res.body), (data) => parseStreamChunkEffect(data));
    for await (const chunk of Stream.toAsyncIterable(parsed)) {
      yield { ...chunk, usage: withEstimatedUsageCost(this.baseUrl, req.model, chunk.usage) };
    }
  }

  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const program = Effect.gen(this, function* () {
      const res = yield* fetchUpstreamEffect(
        this.fetchImpl,
        `${this.baseUrl}${this.apiPrefix}/models`,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
        signal,
      );
      if (!res.ok) return yield* Effect.fail(this.parseError(res.status, yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (err) => err,
      })));

      const result = yield* Effect.tryPromise({
        try: () => res.json() as Promise<ModelsResponse>,
        catch: (err) => err,
      });
      return result.data;
    });
    return runPromiseBoundary(program);
  }

  /**
   * An upstream error envelope is preferred when present; the status-code
   * fallbacks below only apply when the body carries no usable message.
   */
  protected parseError(statusCode: number, body: string): ApiError {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } };
      if (parsed?.error?.message) {
        return new ApiError(
          parsed.error.message,
          (parsed.error.type as ErrorTypeValue) ?? ErrorType.Server,
          parsed.error.code,
          undefined,
          statusCode,
        );
      }
    } catch {
      // not JSON — fall through to the status-code mapping
    }

    switch (statusCode) {
      case 401:
        return new ApiError('invalid API key', ErrorType.Authentication, undefined, undefined, statusCode);
      case 429:
        return new ApiError('rate limit exceeded', ErrorType.RateLimit, undefined, undefined, statusCode);
      case 404:
        return new ApiError('resource not found', ErrorType.NotFound, undefined, undefined, statusCode);
      default:
        return new ApiError(`OpenAI API error: ${body}`, ErrorType.Server, undefined, undefined, statusCode);
    }
  }
}
