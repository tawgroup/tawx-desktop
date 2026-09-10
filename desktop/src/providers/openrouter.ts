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

/** The provider-operated tool the frontend asks for when Web is switched on. */
const WEB_SEARCH_TOOL = 'openrouter:web_search';

/**
 * OpenRouter exposes web search twice over. `openrouter:web_search` is an
 * agentic tool the model may call while generating; the `web` plugin runs one
 * search up front and hands the results to the model with the prompt. They take
 * different parameters and, in practice, different amounts of quota — the tool
 * endpoint answers 429 for requests the plugin serves without complaint.
 *
 * The plugin is what we send. The two are close enough that the caller's intent
 * survives the translation, and the plugin is the path that works.
 */
interface OpenRouterRequest extends ChatCompletionRequest {
  plugins?: WebPlugin[];
}

interface WebPlugin {
  id: 'web';
  engine?: string;
  max_results?: number;
}

interface WebSearchParameters {
  engine?: string;
  max_results?: number;
  max_uses?: number;
}

/**
 * Rewrites a web-search tool into the plugin that performs it.
 *
 * `auto` is the frontend's word for "no preference" and is not one of the
 * engines the plugin accepts (it answers 400), so it becomes an omitted engine
 * and OpenRouter picks. Any other engine is passed through: the caller chose it
 * deliberately, and a rejection tells them more than a silent substitution.
 */
export function translateWebSearch(req: ChatCompletionRequest): OpenRouterRequest {
  const webSearch = req.tools?.find((tool) => tool.type === WEB_SEARCH_TOOL);
  if (!webSearch) return req;

  const params = (webSearch.parameters ?? {}) as WebSearchParameters;
  const remaining = req.tools?.filter((tool) => tool.type !== WEB_SEARCH_TOOL) ?? [];
  const plugin: WebPlugin = { id: 'web' };
  if (params.engine && params.engine !== 'auto') plugin.engine = params.engine;
  if (params.max_results !== undefined) plugin.max_results = params.max_results;

  return {
    ...req,
    // An empty array would advertise "this model has tools" to no purpose.
    tools: remaining.length > 0 ? remaining : undefined,
    plugins: [plugin],
  };
}

export class OpenRouterProvider implements Provider {
  private readonly upstream: OpenAiProvider;

  constructor(options: OpenAiOptions) {
    this.upstream = new OpenAiProvider({ ...options, baseUrl: options.baseUrl || DEFAULT_BASE_URL });
  }

  chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    return this.upstream.chatCompletion(translateWebSearch(req), signal);
  }

  chatCompletionStream(req: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    // usage is opt-in on OpenRouter streams, and the UI shows response cost.
    return this.upstream.chatCompletionStream(
      { ...translateWebSearch(req), stream_options: { include_usage: true } },
      signal,
    );
  }

  listModels(signal?: AbortSignal): Promise<Model[]> {
    return this.upstream.listModels(signal);
  }
}
