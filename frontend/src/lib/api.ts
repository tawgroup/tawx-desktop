import type {
  ChatCompletionMessage,
  CompletionResponse,
  ModelInfo,
  Provider,
  StreamDelta,
  WebSearchEngine,
} from '../types';

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Trims trailing slashes so callers can paste either `.../v1` or `.../v1/`. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Rewrites an absolute URL (http:// or https://) to a same-origin proxy path
 * so the browser never fires a CORS preflight. Relative baseUrls (e.g.
 * "/proxy/9router/v1") are returned untouched — they're already same-origin.
 */
function proxyUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  // Relative → already same-origin, use as-is.
  if (base.startsWith('/')) return `${base}${path}`;
  // Absolute → route through the generic CORS proxy.
  return `/proxy/remote/${base}${path}`;
}

function headers(provider: Provider): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  };
}

/**
 * Extracts a human-readable message from an error response. Providers disagree
 * on the shape ({error:{message}}, {error:"..."}, {message}), so each is tried
 * before falling back to raw text.
 */
async function parseError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `Request failed with status ${res.status}`;
  try {
    const data = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof data.error === 'string') return data.error;
    if (data.error?.message) return data.error.message;
    if (data.message) return data.message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.slice(0, 300);
}

export async function fetchModels(provider: Provider, signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await fetch(proxyUrl(provider.baseUrl, '/models'), {
    headers: headers(provider),
    signal,
  });
  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  const data = (await res.json()) as { data?: ModelInfo[] };
  return data.data ?? [];
}

interface StreamOptions {
  provider: Provider;
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
  onToken: (token: string) => void;
  onModel?: (model: string) => void;
  onReasoning?: (token: string) => void;
  onCost?: (cost: number) => void;
  webSearch?: WebSearchEngine;
}

export function completionBody(options: Pick<StreamOptions, 'model' | 'messages' | 'temperature' | 'maxTokens' | 'webSearch'>, stream: boolean) {
  return {
    model: options.model,
    messages: options.messages,
    stream,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.webSearch ? {
      tools: [{
        type: 'openrouter:web_search',
        parameters: { engine: options.webSearch, max_uses: 1, max_results: 3 },
      }],
    } : {}),
  };
}

/**
 * Streams a completion, invoking `onToken` for each delta.
 *
 * The SSE frames are parsed by hand rather than with EventSource because the
 * endpoint requires a POST with an Authorization header, which EventSource
 * cannot send.
 */
export async function streamCompletion({
  provider,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  onToken,
  onModel,
  onReasoning,
  onCost,
  webSearch,
}: StreamOptions): Promise<string> {
  const res = await fetch(proxyUrl(provider.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    signal,
    body: JSON.stringify(completionBody({ model, messages, temperature, maxTokens, webSearch }, true)),
  });

  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  if (!res.body) throw new ApiError('Response body is empty');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; the last element is kept because
      // it may be an incomplete frame split across chunks.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return full;
          if (!payload) continue;

          try {
            const chunk = JSON.parse(payload) as StreamDelta;
            if (chunk.model) onModel?.(chunk.model);
            if (chunk.usage?.cost !== undefined) onCost?.(chunk.usage.cost);
            const reasoning = chunk.choices?.[0]?.delta?.reasoning;
            if (reasoning) onReasoning?.(reasoning);
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) {
              full += token;
              onToken(token);
            }
          } catch {
            // Ignore keepalive comments and malformed frames.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

/** Non-streaming fallback for endpoints that do not support SSE. */
export async function fetchCompletion({
  provider,
  model,
  messages,
  temperature,
  maxTokens,
  signal,
  webSearch,
}: Omit<StreamOptions, 'onToken' | 'onModel' | 'onReasoning' | 'onCost'>): Promise<{ content: string; model?: string; reasoning?: string; cost?: number }> {
  const res = await fetch(proxyUrl(provider.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    signal,
    body: JSON.stringify(completionBody({ model, messages, temperature, maxTokens, webSearch }, false)),
  });

  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  const data = (await res.json()) as CompletionResponse;
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model,
    reasoning: data.choices?.[0]?.message?.reasoning,
    cost: data.usage?.cost,
  };
}
