/**
 * Local provider — any OpenAI-compatible backend (Ollama, vLLM, llama-server,
 * SGLang, …). Ported from providers/local.go.
 */

import { Effect, Schedule, Stream } from 'effect';
import { ApiError, ErrorType, asApiError, runPromiseBoundary, type ErrorTypeValue } from './errors.js';
import { parseStreamChunkEffect, readSseDataStream } from './streaming.js';
import { serializeRequest } from './wire.js';
import type { Provider } from './provider.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Model,
  ModelsResponse,
  StreamChunk,
} from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

const UPSTREAM_TIMEOUT = '30 seconds' as const;
const upstreamRetrySchedule = Schedule.intersect(Schedule.exponential('200 millis'), Schedule.recurs(2));

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (isAbortLike(err)) return false;
  if ((err as { _tag?: string })?._tag === 'TimeoutException') return false;
  return err instanceof TypeError;
}

function mapTimeout(err: unknown): unknown {
  if ((err as { _tag?: string })?._tag === 'TimeoutException') {
    return new ApiError('backend request timed out', ErrorType.Server);
  }
  return err;
}

/**
 * Interruptible fetch: the Effect runtime's AbortSignal joins the caller's so
 * either side aborts the request, Effect.timeout bounds it, and Effect.retry
 * replays transient transport failures only. Transport errors stay raw —
 * MultiLocal classifies them by shape for failover, exactly as before.
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

export interface LocalOptions {
  baseUrl?: string;
  /** Injected for tests, and for backends reached over a tunnelled transport. */
  fetchImpl?: typeof fetch;
}

export class LocalProvider implements Provider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LocalOptions = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chatCompletion(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const program = Effect.gen(this, function* () {
      const res = yield* fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializeRequest(req, false),
      }, signal);

      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (err) => err,
      });
      if (!res.ok) return yield* Effect.fail(this.parseError(res.status, text));

      return yield* Effect.try({
        try: () => JSON.parse(text) as ChatCompletionResponse,
        catch: (err) =>
          new ApiError(
            `failed to unmarshal response: ${err instanceof Error ? err.message : String(err)}`,
            ErrorType.Server,
          ),
      });
    });
    return runPromiseBoundary(program);
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const res = await runPromiseBoundary(
      fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: serializeRequest(req, true),
      }, signal),
    );

    if (!res.ok) throw this.parseError(res.status, await res.text());
    if (!res.body) throw new ApiError('backend returned no body', ErrorType.Server);

    const parsed = Stream.mapEffect(readSseDataStream(res.body), (data) => parseStreamChunkEffect(data));
    for await (const chunk of Stream.toAsyncIterable(parsed)) {
      yield chunk;
    }
  }

  /**
   * The standard OpenAI-compatible endpoint is tried first so non-Ollama
   * backends work out of the box; Ollama's native /api/tags is the fallback.
   */
  async listModels(signal?: AbortSignal): Promise<Model[]> {
    // The fallback is semantic (endpoint absent), not transient: each leg runs
    // once via the Effect fetch helper without the retry schedule.
    try {
      return await this.listModelsOpenAi(signal);
    } catch {
      return this.listModelsLegacyTags(signal);
    }
  }

  private async listModelsOpenAi(signal?: AbortSignal): Promise<Model[]> {
    const res = await runPromiseBoundary(
      fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}/v1/models`, {}, signal),
    );
    if (!res.ok) throw new ApiError(`status ${res.status}`, ErrorType.Server);
    return ((await res.json()) as ModelsResponse).data;
  }

  private async listModelsLegacyTags(signal?: AbortSignal): Promise<Model[]> {
    const res = await runPromiseBoundary(
      fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}/api/tags`, {}, signal),
    );
    if (!res.ok) throw this.parseError(res.status, await res.text());

    const result = (await res.json()) as { models?: Array<{ name: string; modified_at?: string }> };
    return (result.models ?? []).map((model) => ({
      id: model.name,
      object: 'model',
      created: 0,
      owned_by: 'ollama',
    }));
  }

  /**
   * The OpenAI envelope is tried first: vLLM, SGLang and llama-server all speak
   * it, and reading their 400 as a server error would report a client mistake
   * as a gateway failure. Ollama's native {"error": "message"} is the legacy
   * fallback.
   */
  private parseError(statusCode: number, body: string): ApiError {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }

    const openai = parsed as { error?: { message?: string; type?: string; code?: string } } | undefined;
    if (openai?.error && typeof openai.error === 'object' && openai.error.message) {
      return new ApiError(
        openai.error.message,
        (openai.error.type as ErrorTypeValue) ?? ErrorType.Server,
        openai.error.code,
      );
    }

    const ollama = parsed as { error?: unknown } | undefined;
    if (typeof ollama?.error === 'string' && ollama.error) {
      return new ApiError(ollama.error, ErrorType.Server);
    }

    // the body parsed as neither envelope. it belongs to an arbitrary backend
    // reached over an operator-configured transport, so its contents are not
    // safe to hand a client; report the status instead.
    switch (statusCode) {
      case 404:
        return new ApiError('model not found', ErrorType.NotFound);
      case 503:
        return new ApiError('service unavailable', ErrorType.ServiceUnavailable);
      default:
        return new ApiError(`backend API error (HTTP ${statusCode})`, ErrorType.Server);
    }
  }
}
