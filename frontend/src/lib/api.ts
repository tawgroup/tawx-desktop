import type {
  ApprovalDecision,
  ChatCompletionMessage,
  CompletionResponse,
  CompletionUsage,
  DesktopTaskRequest,
  DesktopTaskSnapshot,
  ModelInfo,
  Provider,
  StreamDelta,
  TaskEvent,
  TaskEventKind,
  WebSearchEngine,
  Workspace,
} from '../types';
import { estimateUsageCost } from './pricing.ts';
import { redactUnknown } from './redaction.ts';

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Turns an in-stream error frame into the same ApiError a failed POST raises. */
function streamError(error: NonNullable<StreamDelta['error']>): ApiError {
  const status = typeof error.code === 'number' ? error.code : undefined;
  return new ApiError(error.message || 'The provider ended the stream with an error', status);
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
  const target = `${base}${path}`;
  return `/proxy/remote?url=${encodeURIComponent(target)}`;
}

function headers(provider: Provider): HeadersInit {
  const requestHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.authKind === 'bearer' && provider.apiKey) {
    requestHeaders.Authorization = `Bearer ${provider.apiKey}`;
  }
  return requestHeaders;
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
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  onToken: (token: string) => void;
  onModel?: (model: string) => void;
  onReasoning?: (token: string) => void;
  onUsage?: (usage: NormalizedCompletionUsage) => void;
  webSearch?: WebSearchEngine;
}

export interface NormalizedCompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

function normalizeCompletionUsage(
  usage: CompletionUsage | undefined,
  provider: Provider,
  model: string,
): NormalizedCompletionUsage | undefined {
  if (!usage) return undefined;
  const normalized = {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
    cost: usage.cost ?? estimateUsageCost(provider, model, usage),
  };
  return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

export function completionBody(options: Pick<StreamOptions, 'model' | 'messages' | 'temperature' | 'maxTokens' | 'reasoningEffort' | 'webSearch'>, stream: boolean) {
  return {
    model: options.model,
    messages: options.messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
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
  reasoningEffort,
  onToken,
  onModel,
  onReasoning,
  onUsage,
  webSearch,
}: StreamOptions): Promise<string> {
  const res = await fetch(proxyUrl(provider.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    signal,
    body: JSON.stringify(completionBody({ model, messages, temperature, maxTokens, reasoningEffort, webSearch }, true)),
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
            // A provider that fails after the response headers are sent reports
            // it in-band. Dropping the frame here would end the turn silently,
            // leaving an empty reply and no way to tell what went wrong.
            if (chunk.error) throw streamError(chunk.error);
            if (chunk.model) onModel?.(chunk.model);
            const usage = normalizeCompletionUsage(chunk.usage, provider, model);
            if (usage) onUsage?.(usage);
            const reasoning = chunk.choices?.[0]?.delta?.reasoning;
            if (reasoning) onReasoning?.(reasoning);
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) {
              full += token;
              onToken(token);
            }
          } catch (err) {
            if (err instanceof ApiError) throw err;
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
  reasoningEffort,
  webSearch,
}: Omit<StreamOptions, 'onToken' | 'onModel' | 'onReasoning' | 'onUsage'>): Promise<{ content: string; model?: string; reasoning?: string; usage?: NormalizedCompletionUsage }> {
  const res = await fetch(proxyUrl(provider.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(provider),
    signal,
    body: JSON.stringify(completionBody({ model, messages, temperature, maxTokens, reasoningEffort, webSearch }, false)),
  });

  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  const data = (await res.json()) as CompletionResponse;
  // Same in-band failure as the streaming path: a 200 body carrying an error
  // must not be read as an empty reply.
  if (data.error) throw streamError(data.error);
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model,
    reasoning: data.choices?.[0]?.message?.reasoning,
    usage: normalizeCompletionUsage(data.usage, provider, model),
  };
}

const TASK_EVENT_KINDS: Record<TaskEventKind, true> = {
  status: true,
  assistant_delta: true,
  reasoning_delta: true,
  todo: true,
  tool_call: true,
  approval_required: true,
  tool_result: true,
  file_diff: true,
  artifact: true,
  context: true,
  usage: true,
  done: true,
  error: true,
};

async function desktopRequest<T>(
  path: string,
  init: RequestInit = {},
  emptyValue?: T,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  if (res.status === 204) return emptyValue as T;
  return res.json() as Promise<T>;
}

export async function selectDesktopWorkspace(signal?: AbortSignal): Promise<Workspace | null> {
  return desktopRequest<Workspace | null>(
    '/desktop/workspace/select',
    { method: 'POST', signal },
    null,
  );
}

export async function createDesktopTask(
  request: DesktopTaskRequest,
  signal?: AbortSignal,
): Promise<{ id: string }> {
  return desktopRequest('/desktop/tasks', {
    method: 'POST',
    signal,
    body: JSON.stringify(request),
  });
}

export async function fetchDesktopTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<DesktopTaskSnapshot> {
  const snapshot = await desktopRequest<DesktopTaskSnapshot>(
    `/desktop/tasks/${encodeURIComponent(taskId)}`,
    { signal },
  );
  return normalizeDesktopTaskSnapshot(snapshot);
}

export async function cancelDesktopTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<DesktopTaskSnapshot> {
  const snapshot = await desktopRequest<DesktopTaskSnapshot>(
    `/desktop/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: 'POST', signal },
  );
  return normalizeDesktopTaskSnapshot(snapshot);
}

export async function approveDesktopTask(
  taskId: string,
  approvalId: string,
  decision: ApprovalDecision,
  signal?: AbortSignal,
): Promise<DesktopTaskSnapshot> {
  const snapshot = await desktopRequest<DesktopTaskSnapshot>(
    `/desktop/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', signal, body: JSON.stringify({ decision }) },
  );
  return normalizeDesktopTaskSnapshot(snapshot);
}

export async function undoDesktopTask(taskId: string, signal?: AbortSignal): Promise<void> {
  await desktopRequest(
    `/desktop/tasks/${encodeURIComponent(taskId)}/undo`,
    { method: 'POST', signal },
    undefined,
  );
}

function normalizeDesktopTaskEvent(value: unknown, eventId = ''): TaskEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.taskId !== 'string'
    || typeof event.kind !== 'string'
    || !TASK_EVENT_KINDS[event.kind as TaskEventKind]
  ) {
    return null;
  }
  const parsedTimestamp = typeof event.timestamp === 'number'
    ? event.timestamp
    : typeof event.timestamp === 'string'
      ? Date.parse(event.timestamp)
      : Number.NaN;
  if (!Number.isFinite(parsedTimestamp) || event.payload === undefined) return null;
  const id = typeof event.id === 'string' || typeof event.id === 'number'
    ? String(event.id)
    : eventId;
  return {
    id: id || `${event.taskId}:${parsedTimestamp}:${event.kind}`,
    taskId: event.taskId,
    kind: event.kind as TaskEventKind,
    timestamp: parsedTimestamp,
    payload: redactUnknown(event.payload) as TaskEvent['payload'],
  };
}

function normalizeDesktopTaskSnapshot(snapshot: DesktopTaskSnapshot): DesktopTaskSnapshot {
  return {
    ...snapshot,
    events: snapshot.events
      ?.map((event) => normalizeDesktopTaskEvent(event))
      .filter((event): event is TaskEvent => event !== null),
  };
}

export function parseDesktopTaskEvent(data: string, eventId = ''): TaskEvent | null {
  try {
    return normalizeDesktopTaskEvent(JSON.parse(data), eventId);
  } catch {
    return null;
  }
}

export interface DesktopTaskStreamOptions {
  signal?: AbortSignal;
  lastEventId?: string;
  onEvent: (event: TaskEvent) => void | Promise<void>;
}

/** Streams inspectable desktop task events over authenticated same-origin SSE. */
export async function streamDesktopTaskEvents(
  taskId: string,
  options: DesktopTaskStreamOptions,
): Promise<void> {
  const res = await fetch(`/desktop/tasks/${encodeURIComponent(taskId)}/events`, {
    headers: {
      Accept: 'text/event-stream',
      ...(options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
    },
    signal: options.signal,
  });
  if (!res.ok) throw new ApiError(await parseError(res), res.status);
  if (!res.body) throw new ApiError('Task event stream is empty');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeFrame = async (frame: string) => {
    let eventId = '';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) eventId = line.slice(3).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const event = parseDesktopTaskEvent(data.join('\n'), eventId);
    if (event) await options.onEvent(event);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) await consumeFrame(frame);
      if (done) break;
    }
    if (buffer.trim()) await consumeFrame(buffer);
  } finally {
    reader.releaseLock();
  }
}
