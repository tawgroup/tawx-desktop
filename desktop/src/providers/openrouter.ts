/**
 * OpenRouter provider. Ported from providers/openrouter.go.
 *
 * Model-id prefixing used to live here: the adapter added `openrouter/` to
 * every listed model and stripped it again on the way out. That belonged to the
 * gateway's naming, not to OpenRouter's, and now happens once at the
 * aggregation point — /v1/models qualifies every id as `<providerId>/<model>`
 * and Router strips the selector before the request reaches an adapter.
 */

import { OpenAiProvider } from './openai.js';
import type { OpenAiOptions } from './openai.js';
import type { Provider } from './provider.js';
import type { ChatCompletionRequest, ChatCompletionResponse, Model, StreamChunk } from './types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api';

export class OpenRouterProvider implements Provider {
  private readonly upstream: OpenAiProvider;

  constructor(options: OpenAiOptions) {
    this.upstream = new OpenAiProvider({ ...options, baseUrl: options.baseUrl || DEFAULT_BASE_URL });
  }

  chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    return this.upstream.chatCompletion(req, signal);
  }

  chatCompletionStream(req: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    // usage is opt-in on OpenRouter streams, and the UI shows response cost.
    return this.upstream.chatCompletionStream({ ...req, stream_options: { include_usage: true } }, signal);
  }

  listModels(signal?: AbortSignal): Promise<Model[]> {
    return this.upstream.listModels(signal);
  }
}
