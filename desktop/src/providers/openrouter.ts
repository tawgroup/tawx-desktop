/**
 * OpenRouter provider. Ported from providers/openrouter.go.
 *
 * Model-id prefixing used to live here: the adapter added `openrouter/` to
 * every listed model and stripped it again on the way out. That belonged to the
 * gateway's naming, not to OpenRouter's, and now happens once at the
 * aggregation point — /v1/models qualifies every id as `<providerId>/<model>`
 * and Router strips the selector before the request reaches an adapter.
 */

import { ApiError } from './errors.js';
import { OpenAiProvider } from './openai.js';
import type { OpenAiOptions } from './openai.js';
import type { Provider } from './provider.js';
import type { ChatCompletionRequest, ChatCompletionResponse, Model, StreamChunk } from './types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api';

/** The provider-operated tool the frontend asks for when Web is switched on. */
const WEB_SEARCH_TOOL = 'openrouter:web_search';

/**
 * OpenRouter exposes web search twice over. `openrouter:web_search` is a server
 * tool the model calls while generating: it writes the query itself, with the
 * whole conversation in view. The `web` plugin instead runs one search up front
 * against a query OpenRouter derives from the last message alone — so a follow-up
 * that only makes sense in context ("look up the 2026 squad", in a thread about
 * Argentina) searches for the words alone and hands the model answers about
 * something else entirely, under a prompt instructing it to use them.
 *
 * The tool is therefore what we send. The plugin is the fallback: OpenRouter's
 * tool endpoint has answered 429 for requests the plugin served in the same
 * second, and not every model carries server tools, so a request rejected
 * outright is retried down the path that always works.
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
 * Statuses that mean the tool call was refused rather than answered badly:
 * out of quota, unknown tool, model without server tools. Anything else is a
 * real failure the plugin would meet too.
 */
const PLUGIN_FALLBACK_STATUSES = new Set([400, 404, 429]);

function hasWebSearchTool(req: ChatCompletionRequest): boolean {
  return req.tools?.some((tool) => tool.type === WEB_SEARCH_TOOL) ?? false;
}

/**
 * Whether a failure is worth retrying as the plugin. An abort is the user
 * leaving, not a rejection. OpenRouter reports the status in `code` when the
 * error arrives mid-stream, where there is no response status left to read.
 */
function rejectsWebSearchTool(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || !(err instanceof ApiError)) return false;
  return PLUGIN_FALLBACK_STATUSES.has(err.status ?? Number(err.code));
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

  async chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    try {
      return await this.upstream.chatCompletion(req, signal);
    } catch (err) {
      if (!hasWebSearchTool(req) || !rejectsWebSearchTool(err, signal)) throw err;
      // The plugin's own failure is the one worth reporting: it is the path
      // that was supposed to work.
      return this.upstream.chatCompletion(translateWebSearch(req), signal);
    }
  }

  async *chatCompletionStream(req: ChatCompletionRequest, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // usage is opt-in on OpenRouter streams, and the UI shows response cost.
    const withUsage = { ...req, stream_options: { include_usage: true } };
    let started = false;

    try {
      for await (const chunk of this.upstream.chatCompletionStream(withUsage, signal)) {
        started = true;
        yield chunk;
      }
      return;
    } catch (err) {
      // Once a chunk is out the client holds half an answer, and replaying the
      // request would append a second one to it.
      if (started || !hasWebSearchTool(req) || !rejectsWebSearchTool(err, signal)) throw err;
    }

    yield* this.upstream.chatCompletionStream(translateWebSearch(withUsage), signal);
  }

  listModels(signal?: AbortSignal): Promise<Model[]> {
    return this.upstream.listModels(signal);
  }
}
