/**
 * OpenRouter provider. Ported from providers/openrouter.go.
 *
 * Adapts gateway selector names to OpenRouter's model IDs: the gateway calls a
 * model `openrouter/foo`, OpenRouter itself wants plain `foo`.
 */

import { OpenAiProvider } from './openai.js';
import type { OpenAiOptions } from './openai.js';
import type { Provider } from './provider.js';
import type { ChatCompletionRequest, ChatCompletionResponse, Model, StreamChunk } from './types.js';

const OPENROUTER_PREFIX = 'openrouter/';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api';

const stripPrefix = (model: string) =>
  model.startsWith(OPENROUTER_PREFIX) ? model.slice(OPENROUTER_PREFIX.length) : model;

export class OpenRouterProvider implements Provider {
  private readonly upstream: OpenAiProvider;

  constructor(options: OpenAiOptions) {
    this.upstream = new OpenAiProvider({ ...options, baseUrl: options.baseUrl || DEFAULT_BASE_URL });
  }

  chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    return this.upstream.chatCompletion({ ...req, model: stripPrefix(req.model) }, signal);
  }

  chatCompletionStream(req: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    // usage is opt-in on OpenRouter streams, and the UI shows response cost.
    return this.upstream.chatCompletionStream(
      { ...req, model: stripPrefix(req.model), stream_options: { include_usage: true } },
      signal,
    );
  }

  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const models = await this.upstream.listModels(signal);
    return models.map((model) => ({ ...model, id: OPENROUTER_PREFIX + model.id }));
  }
}
