import { OpenAiProvider } from './openai.js';
import type { OpenAiOptions } from './openai.js';
import type { Provider } from './provider.js';
import type { ChatCompletionRequest, ChatCompletionResponse, Model, StreamChunk } from './types.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/** Gemini's OpenAI-compatible surface omits the usual `/v1` path segment. */
export class GoogleProvider implements Provider {
  private readonly upstream: OpenAiProvider;

  constructor(options: OpenAiOptions) {
    this.upstream = new OpenAiProvider({
      ...options,
      baseUrl: options.baseUrl || DEFAULT_BASE_URL,
      apiPrefix: '',
    });
  }

  chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    return this.upstream.chatCompletion(req, signal);
  }

  chatCompletionStream(req: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    return this.upstream.chatCompletionStream(req, signal);
  }

  listModels(signal?: AbortSignal): Promise<Model[]> {
    return this.upstream.listModels(signal);
  }
}
