/** OpenAI provider. Ported from providers/openai.go. */

import { ApiError, ErrorType, type ErrorTypeValue } from './errors.js';
import { parseStreamChunk, readSseData } from './streaming.js';
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
    const res = await this.fetchImpl(`${this.baseUrl}${this.apiPrefix}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: serializeRequest(req, false),
      signal,
    });

    const text = await res.text();
    if (!res.ok) throw this.parseError(res.status, text);

    try {
      const result = JSON.parse(text) as ChatCompletionResponse;
      return { ...result, usage: withEstimatedUsageCost(this.baseUrl, req.model, result.usage) };
    } catch (err) {
      throw new ApiError(
        `failed to unmarshal response: ${err instanceof Error ? err.message : String(err)}`,
        ErrorType.Server,
      );
    }
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const res = await this.fetchImpl(`${this.baseUrl}${this.apiPrefix}/chat/completions`, {
      method: 'POST',
      headers: this.headers({ Accept: 'text/event-stream' }),
      body: serializeRequest(req, true),
      signal,
    });

    if (!res.ok) throw this.parseError(res.status, await res.text());
    if (!res.body) throw new ApiError('upstream returned no body', ErrorType.Server);

    for await (const data of readSseData(res.body)) {
      const chunk = parseStreamChunk(data);
      yield { ...chunk, usage: withEstimatedUsageCost(this.baseUrl, req.model, chunk.usage) };
    }
  }

  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const res = await this.fetchImpl(`${this.baseUrl}${this.apiPrefix}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
    });

    if (!res.ok) throw this.parseError(res.status, await res.text());

    const result = (await res.json()) as ModelsResponse;
    return result.data;
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
        );
      }
    } catch {
      // not JSON — fall through to the status-code mapping
    }

    switch (statusCode) {
      case 401:
        return new ApiError('invalid API key', ErrorType.Authentication);
      case 429:
        return new ApiError('rate limit exceeded', ErrorType.RateLimit);
      case 404:
        return new ApiError('resource not found', ErrorType.NotFound);
      default:
        return new ApiError(`OpenAI API error: ${body}`, ErrorType.Server);
    }
  }
}
