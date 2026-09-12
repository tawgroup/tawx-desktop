import { Cause, Data, Effect, Stream } from 'effect';
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

// ---------------------------------------------------------------------------
// Effect foundation. The public surface below stays Promise-based so callers
// (stores, components) keep working unchanged; every Effect is run at the
// boundary with runPromiseBoundary, which rethrows the typed failure raw
// instead of an Effect FiberFailure wrapper. This mirrors desktop's
// providers/errors.ts after the backend Effect migration.
// ---------------------------------------------------------------------------

/** Which polymorphic error-body shape produced the message. */
export type ErrorBodyShape = 'error-string' | 'error-message' | 'message' | 'raw' | 'empty';

/** A non-2xx response, with the shape that carried its message recorded. */
export class ApiHttpError extends Data.TaggedError('ApiHttpError')<{
  readonly message: string;
  readonly status: number;
  readonly shape: ErrorBodyShape;
}> {}

/** A failure that never became an HTTP response (or an unreadable body). */
export class ApiNetworkError extends Data.TaggedError('ApiNetworkError')<{
  readonly message: string;
  readonly reason: 'transport' | 'empty-body';
  readonly cause?: unknown;
}> {}

export type ApiEffectError = ApiHttpError | ApiNetworkError;

/** Lowers a TaggedError back to the ApiError callers already catch. */
export function toApiError(err: ApiEffectError): ApiError {
  if (err._tag === 'ApiHttpError') return new ApiError(err.message, err.status);
  return new ApiError(err.message);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Runs an Effect at the async boundary, rethrowing the failure value raw.
 * TaggedErrors become ApiError; DOM AbortErrors and TypeErrors (the shapes
 * useChats checks for abort vs. offline) pass through untouched.
 */
export function runPromiseBoundary<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (exit._tag === 'Success') return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === 'Some') {
      const err = failure.value as unknown;
      if (err instanceof ApiError) throw err;
      if (typeof err === 'object' && err !== null && '_tag' in err) {
        const tag = (err as { _tag: string })._tag;
        if (tag === 'ApiHttpError' || tag === 'ApiNetworkError') {
          throw toApiError(err as ApiEffectError);
        }
      }
      throw err;
    }
    throw Cause.squash(exit.cause);
  });
}

/**
 * fetch wrapped as an interruptible Effect. The runtime's own AbortSignal is
 * combined with the caller's (AbortSignal.any, as the backend does in
 * desktop/src/providers/openai.ts), so either side — UI "stop" or Effect
 * interrupt — aborts the request. Aborts and transport TypeErrors stay raw so
 * existing `instanceof` checks keep classifying them.
 */
function fetchEffect(url: string, init: RequestInit, outerSignal?: AbortSignal): Effect.Effect<Response, ApiNetworkError> {
  return Effect.tryPromise({
    try: (abortSignal) =>
      fetch(url, {
        ...init,
        signal: outerSignal ? AbortSignal.any([outerSignal, abortSignal]) : abortSignal,
      }),
    catch: (err) => err,
  }).pipe(
    Effect.catchAll((err) => {
      if (isAbortError(err)) return Effect.fail(err as never);
      if (err instanceof TypeError) return Effect.fail(err as never);
      const message = err instanceof Error ? err.message : String(err);
      return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
    }),
  ) as Effect.Effect<Response, ApiNetworkError>;
}

/**
 * Classifies the polymorphic error body ({error:{message}} vs {error:"..."}
 * vs {message} vs raw text) into a message plus the shape that carried it.
 */
export function classifyErrorBody(text: string, status: number): { message: string; shape: ErrorBodyShape } {
  if (!text) return { message: `Request failed with status ${status}`, shape: 'empty' };
  try {
    const data = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof data.error === 'string') return { message: data.error, shape: 'error-string' };
    if (data.error?.message) return { message: data.error.message, shape: 'error-message' };
    if (data.message) return { message: data.message, shape: 'message' };
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return { message: text.slice(0, 300), shape: 'raw' };
}

/** Reads the body and fails with the classified ApiHttpError. */
function httpErrorEffect(res: Response): Effect.Effect<never, ApiHttpError> {
  return Effect.map(
    Effect.promise(() => res.text().catch(() => '')),
    (text) => classifyErrorBody(text, res.status),
  ).pipe(
    Effect.flatMap(({ message, shape }) => Effect.fail(new ApiHttpError({ message, status: res.status, shape }))),
  );
}

/** Fails with ApiHttpError when the response is not ok. */
function ensureOk(res: Response): Effect.Effect<Response, ApiHttpError | ApiNetworkError> {
  return res.ok ? Effect.succeed(res) : httpErrorEffect(res);
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
 * before falling back to raw text. Effect inside, Promise at the boundary.
 */
export async function parseError(res: Response): Promise<string> {
  return runPromiseBoundary(parseErrorEffect(res));
}

function parseErrorEffect(res: Response): Effect.Effect<string, never> {
  return Effect.map(
    Effect.promise(() => res.text().catch(() => '')),
    (text) => classifyErrorBody(text, res.status).message,
  );
}

function fetchModelsEffect(provider: Provider, signal?: AbortSignal): Effect.Effect<ModelInfo[], ApiEffectError> {
  return Effect.gen(function* () {
    const res = yield* fetchEffect(proxyUrl(provider.baseUrl, '/models'), {
      headers: headers(provider),
    }, signal);
    yield* ensureOk(res);
    const data = (yield* Effect.tryPromise({
      try: () => res.json() as Promise<{ data?: ModelInfo[] }>,
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        if (isAbortError(err) || err instanceof TypeError) return Effect.fail(err as never);
        const message = err instanceof Error ? err.message : String(err);
        return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
      }),
    )) as { data?: ModelInfo[] };
    return data.data ?? [];
  });
}

export async function fetchModels(provider: Provider, signal?: AbortSignal): Promise<ModelInfo[]> {
  return runPromiseBoundary(fetchModelsEffect(provider, signal));
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
 * SSE `data:` payloads as an async iterable. Frames are separated by a blank
 * line; the trailing element is kept because it may be an incomplete frame
 * split across chunks. `[DONE]` terminates, matching the previous hand-rolled
 * loop (EventSource cannot send the POST's Authorization header).
 */
async function* ssePayloadIterable(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;
          if (payload) yield payload;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** The SSE payloads as an Effect Stream. */
function ssePayloadStream(body: ReadableStream<Uint8Array>): Stream.Stream<string, ApiNetworkError> {
  return Stream.fromAsyncIterable(ssePayloadIterable(body), (err) => {
    if (err instanceof ApiError) return new ApiNetworkError({ message: err.message, reason: 'transport', cause: err });
    const message = err instanceof Error ? err.message : String(err);
    return new ApiNetworkError({ message, reason: 'transport', cause: err });
  });
}

interface CompletionSink {
  onToken: (token: string) => void;
  onModel?: (model: string) => void;
  onReasoning?: (token: string) => void;
  onUsage?: (usage: NormalizedCompletionUsage) => void;
}

/**
 * Folds one SSE payload into the accumulated text. An in-band error envelope
 * fails (surfacing instead of ending the turn silently); malformed frames are
 * ignored, as before.
 */
function consumeCompletionPayload(
  payload: string,
  provider: Provider,
  model: string,
  sink: CompletionSink,
  full: string,
): Effect.Effect<string, ApiError> {
  let chunk: StreamDelta;
  try {
    chunk = JSON.parse(payload) as StreamDelta;
  } catch {
    // Ignore keepalive comments and malformed frames.
    return Effect.succeed(full);
  }
  // A provider that fails after the response headers are sent reports
  // it in-band. Dropping the frame here would end the turn silently,
  // leaving an empty reply and no way to tell what went wrong.
  if (chunk.error) return Effect.fail(streamError(chunk.error));
  return Effect.sync(() => {
    if (chunk.model) sink.onModel?.(chunk.model);
    const usage = normalizeCompletionUsage(chunk.usage, provider, model);
    if (usage) sink.onUsage?.(usage);
    const reasoning = chunk.choices?.[0]?.delta?.reasoning;
    if (reasoning) sink.onReasoning?.(reasoning);
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) {
      sink.onToken(token);
      return full + token;
    }
    return full;
  });
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
  return runPromiseBoundary(streamCompletionEffect({
    provider, model, messages, temperature, maxTokens, signal,
    reasoningEffort, onToken, onModel, onReasoning, onUsage, webSearch,
  }));
}

function streamCompletionEffect(options: StreamOptions): Effect.Effect<string, ApiEffectError | ApiError> {
  const { provider, model } = options;
  const sink: CompletionSink = {
    onToken: options.onToken,
    onModel: options.onModel,
    onReasoning: options.onReasoning,
    onUsage: options.onUsage,
  };
  return Effect.gen(function* () {
    const res = yield* fetchEffect(proxyUrl(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify(completionBody({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        webSearch: options.webSearch,
      }, true)),
    }, options.signal);
    yield* ensureOk(res);
    if (!res.body) {
      return yield* Effect.fail(new ApiNetworkError({ message: 'Response body is empty', reason: 'empty-body' }));
    }
    return yield* Stream.runFoldEffect(
      ssePayloadStream(res.body),
      '',
      (full, payload) => consumeCompletionPayload(payload, provider, model, sink, full),
    );
  });
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
  return runPromiseBoundary(fetchCompletionEffect({
    provider, model, messages, temperature, maxTokens, signal, reasoningEffort, webSearch,
  }));
}

function fetchCompletionEffect(options: Omit<StreamOptions, 'onToken' | 'onModel' | 'onReasoning' | 'onUsage'>): Effect.Effect<{
  content: string;
  model?: string;
  reasoning?: string;
  usage?: NormalizedCompletionUsage;
}, ApiEffectError | ApiError> {
  const { provider, model } = options;
  return Effect.gen(function* () {
    const res = yield* fetchEffect(proxyUrl(provider.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(provider),
      body: JSON.stringify(completionBody({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        webSearch: options.webSearch,
      }, false)),
    }, options.signal);
    yield* ensureOk(res);
    const data = (yield* Effect.tryPromise({
      try: () => res.json() as Promise<CompletionResponse>,
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        if (isAbortError(err) || err instanceof TypeError) return Effect.fail(err as never);
        const message = err instanceof Error ? err.message : String(err);
        return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
      }),
    )) as CompletionResponse;
    // Same in-band failure as the streaming path: a 200 body carrying an error
    // must not be read as an empty reply.
    if (data.error) return yield* Effect.fail(streamError(data.error));
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: data.model,
      reasoning: data.choices?.[0]?.message?.reasoning,
      usage: normalizeCompletionUsage(data.usage, provider, model),
    };
  });
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

function desktopRequestEffect<T>(
  path: string,
  init: RequestInit = {},
  emptyValue?: T,
): Effect.Effect<T, ApiEffectError> {
  return Effect.gen(function* () {
    const res = yield* fetchEffect(path, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    }, init.signal ?? undefined);
    yield* ensureOk(res);
    if (res.status === 204) return emptyValue as T;
    return (yield* Effect.tryPromise({
      try: () => res.json() as Promise<T>,
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        if (isAbortError(err) || err instanceof TypeError) return Effect.fail(err as never);
        const message = err instanceof Error ? err.message : String(err);
        return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
      }),
    )) as T;
  });
}

async function desktopRequest<T>(
  path: string,
  init: RequestInit = {},
  emptyValue?: T,
): Promise<T> {
  return runPromiseBoundary(desktopRequestEffect(path, init, emptyValue));
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

/**
 * One raw SSE frame (id + data lines) from the task event stream. Multi-line
 * data is joined, matching the previous hand-rolled consumeFrame.
 */
function parseTaskFrame(frame: string): { eventId: string; data: string } | null {
  let eventId = '';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('id:')) eventId = line.slice(3).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { eventId, data: data.join('\n') };
}

async function* taskEventFrameIterable(body: ReadableStream<Uint8Array>): AsyncGenerator<{ eventId: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const parsed = parseTaskFrame(frame);
        if (parsed) yield parsed;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parseTaskFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function taskEventFrameStream(body: ReadableStream<Uint8Array>): Stream.Stream<{ eventId: string; data: string }, ApiNetworkError> {
  return Stream.fromAsyncIterable(taskEventFrameIterable(body), (err) => {
    const message = err instanceof Error ? err.message : String(err);
    return new ApiNetworkError({ message, reason: 'transport', cause: err });
  });
}

/** Streams inspectable desktop task events over authenticated same-origin SSE. */
export async function streamDesktopTaskEvents(
  taskId: string,
  options: DesktopTaskStreamOptions,
): Promise<void> {
  return runPromiseBoundary(streamDesktopTaskEventsEffect(taskId, options));
}

function streamDesktopTaskEventsEffect(
  taskId: string,
  options: DesktopTaskStreamOptions,
): Effect.Effect<void, ApiEffectError> {
  return Effect.gen(function* () {
    const res = yield* fetchEffect(`/desktop/tasks/${encodeURIComponent(taskId)}/events`, {
      headers: {
        Accept: 'text/event-stream',
        ...(options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
      },
    }, options.signal);
    yield* ensureOk(res);
    if (!res.body) {
      return yield* Effect.fail(new ApiNetworkError({ message: 'Task event stream is empty', reason: 'empty-body' }));
    }
    yield* Stream.runForEach(taskEventFrameStream(res.body), (frame) =>
      Effect.tryPromise({
        try: () => {
          const event = parseDesktopTaskEvent(frame.data, frame.eventId);
          return event ? Promise.resolve(options.onEvent(event)).then(() => undefined) : Promise.resolve(undefined);
        },
        catch: (err) => err,
      }).pipe(
        Effect.catchAll((err) => {
          if (isAbortError(err) || err instanceof TypeError) return Effect.fail(err as never);
          const message = err instanceof Error ? err.message : String(err);
          return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
        }),
      ),
    );
  });
}
