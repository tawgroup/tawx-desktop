/**
 * Cursor provider — reaches a Cursor subscription's models directly.
 *
 * Every other provider here speaks an OpenAI-shaped JSON API over `fetch`.
 * Cursor does not: it exposes one bidirectional Connect RPC,
 * `/agent.v1.AgentService/Run`, carrying binary protobuf over HTTP/2, and it
 * drives the exchange rather than answering it. Before a single token arrives
 * the server asks the client for prompt blobs it does not have cached and for a
 * description of the workspace; a client that only writes a request and waits
 * for deltas stalls forever. That protocol is documented in
 * docs/cursor-protocol.md, including how to re-derive the field numbers used
 * below when Cursor changes them.
 *
 * Cursor owns the opaque representation of prior turns. The adapter caches each
 * streamed conversation checkpoint and reuses it when the OpenAI-shaped request
 * contains the matching transcript. Reconstructing turns locally is only a
 * fallback for conversations created before this provider instance.
 *
 * Tools are deliberately not wired up. Cursor's agent API expects its own tool
 * vocabulary (`piBashArgs`, `piEditArgs`, …) with the server driving execution,
 * which is a different contract from the OpenAI `tools` array this interface
 * carries. Chat mode does not need it; a request carrying tools is answered as
 * plain text rather than silently mistranslated.
 */

import { connect as http2Connect, type ClientHttp2Session } from 'node:http2';
import { createHash, randomUUID } from 'node:crypto';
import { Effect, Schedule } from 'effect';
import { ApiError, ErrorType, runPromiseBoundary } from './errors.js';
import type { Provider } from './provider.js';
import {
  FLAG_END_STREAM,
  bytesField,
  concat,
  decodeMessage,
  encodeBytesField,
  encodeFrame,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  hasField,
  messageField,
  numberField,
  readFrames,
  stringField,
  type ProtoField,
} from './cursorWire.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Message,
  Model,
  StreamChunk,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api2.cursor.sh';

/**
 * A real released Cursor CLI build string. The server gates on this header, so
 * it is pinned rather than invented; bump it when Cursor stops accepting it.
 */
const CLIENT_VERSION = 'cli-2026.07.23-e383d2b';

const RUN_PATH = '/agent.v1.AgentService/Run';
const MODELS_PATH = '/agent.v1.AgentService/GetUsableModels';

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

const UNARY_TIMEOUT = '30 seconds' as const;
const unaryRetrySchedule = Schedule.intersect(Schedule.exponential('200 millis'), Schedule.recurs(2));

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Only transport failures are replayed; ApiError statuses and aborts are final. */
function isRetryableUnaryError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (isAbortLike(err)) return false;
  if ((err as { _tag?: string })?._tag === 'TimeoutException') return false;
  return true;
}

function mapUnaryTimeout(err: unknown): unknown {
  if ((err as { _tag?: string })?._tag === 'TimeoutException') {
    return new ApiError('cursor: request timed out', ErrorType.Server);
  }
  return err;
}

export interface CursorOptions {
  /** The OAuth access token, not an API key. `omp token cursor` prints one. */
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  /** Injected by tests so the protocol can be exercised without a network. */
  connectImpl?: typeof http2Connect;
}

export class CursorProvider implements Provider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clientVersion: string;
  private readonly connectImpl: typeof http2Connect;
  private readonly conversations = new Map<string, CursorConversation>();

  constructor(options: CursorOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.clientVersion = options.clientVersion || CLIENT_VERSION;
    this.connectImpl = options.connectImpl ?? http2Connect;
  }

  async chatCompletion(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    let content = '';
    let reasoning = '';
    let id = '';
    let completionTokens = 0;
    for await (const chunk of this.chatCompletionStream(req, signal)) {
      id ||= chunk.id;
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) content += delta.content;
      if (delta?.reasoning) reasoning += delta.reasoning;
      if (chunk.usage) completionTokens = chunk.usage.completion_tokens;
    }
    return {
      id: id || `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, ...(reasoning ? { reasoning } : {}) },
          finish_reason: 'stop',
        },
      ],
      // Cursor bills the subscription, not the request: it reports output
      // tokens only, and no prompt count to derive a total from.
      usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens },
    };
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    if (!this.apiKey) throw new ApiError('Cursor access token is required', ErrorType.Authentication);

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const prior = this.conversations.get(conversationKey(req.model, priorMessages(req.messages)));
    const blobs = prior?.blobs ?? new BlobStore();
    const conversationId = prior?.conversationId ?? randomUUID();
    const body = buildRunRequest(req, blobs, prior?.checkpoint, conversationId);

    const chunk = (delta: StreamChunk['choices'][0]['delta']): StreamChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: req.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });

    let tokens = 0;
    let content = '';
    let reasoning = '';
    let checkpoint: Uint8Array | undefined;
    for await (const update of this.runStream(body, blobs, signal)) {
      if (update.kind === 'text') {
        content += update.text;
        yield chunk({ content: update.text });
      } else if (update.kind === 'thinking') {
        reasoning += update.text;
        yield chunk({ reasoning: update.text });
      } else if (update.kind === 'tokens') tokens = update.tokens;
      else checkpoint = update.checkpoint;
    }

    if (checkpoint) {
      const completed = [
        ...req.messages,
        { role: 'assistant' as const, content, ...(reasoning ? { reasoning } : {}) },
      ];
      this.rememberConversation(conversationKey(req.model, completed), {
        checkpoint,
        blobs,
        conversationId,
      });
    }

    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
    };
  }

  private rememberConversation(key: string, conversation: CursorConversation): void {
    this.conversations.delete(key);
    this.conversations.set(key, conversation);
    if (this.conversations.size > 100) {
      this.conversations.delete(this.conversations.keys().next().value as string);
    }
  }

  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const payload = await this.unary(MODELS_PATH, new Uint8Array(0), signal);
    const created = Math.floor(Date.now() / 1000);
    // GetUsableModelsResponse carries a repeated model message whose first
    // field is the id; anything else in it is presentation we do not need.
    return decodeMessage(payload)
      .filter((f) => f.no === 1 && f.value instanceof Uint8Array)
      .map((f) => stringField(decodeMessage(f.value as Uint8Array), 1))
      .filter((modelId) => modelId.length > 0)
      .map((modelId) => ({ id: modelId, object: 'model', created, owned_by: 'cursor' }));
  }

  private headers(path: string, contentType: string): Record<string, string> {
    return {
      ':method': 'POST',
      ':path': path,
      'content-type': contentType,
      'connect-protocol-version': '1',
      te: 'trailers',
      authorization: `Bearer ${this.apiKey}`,
      'x-ghost-mode': 'true',
      'x-cursor-client-version': this.clientVersion,
      'x-cursor-client-type': 'cli',
      'x-request-id': randomUUID(),
    };
  }

  private async unary(path: string, body: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    // The whole exchange — connect, request, listeners — is set up atomically
    // inside one Effect.async registration, so nothing can emit between setup
    // steps. The Effect runtime's AbortSignal joins the caller's (abort via
    // Effect interrupt), Effect.timeout bounds the call, Effect.retry replays
    // transport failures only, and interruption/settlement closes the session
    // via the async cleanup (Effect scope release).
    const attempt: Effect.Effect<Uint8Array, unknown> = Effect.async<Uint8Array, unknown>((resume, effectSignal) => {
      let session: ClientHttp2Session;
      try {
        session = this.connectImpl(this.baseUrl);
      } catch (err) {
        resume(Effect.fail(err));
        return;
      }
      const request = session.request(this.headers(path, 'application/proto'));
      const parts: Buffer[] = [];
      let settled = false;
      const onOuterAbort = () => request.destroy(new Error('aborted'));
      const onEffectAbort = () => request.destroy(new Error('aborted'));
      const settle = (effect: Effect.Effect<Uint8Array, unknown>) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onOuterAbort);
        effectSignal.removeEventListener('abort', onEffectAbort);
        session.close();
        resume(effect);
      };
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      effectSignal.addEventListener('abort', onEffectAbort, { once: true });
      session.on('error', (err) => settle(Effect.fail(err)));
      request.on('error', (err) => settle(Effect.fail(err)));
      request.on('response', (headers) => {
        const status = Number(headers[':status'] ?? 0);
        if (status !== 200) settle(Effect.fail(statusError(status)));
      });
      request.on('data', (part: Buffer) => parts.push(part));
      request.on('end', () => settle(Effect.succeed(new Uint8Array(Buffer.concat(parts)))));
      request.end(Buffer.from(body));
    }).pipe(
      Effect.timeout(UNARY_TIMEOUT),
      Effect.catchAll((err) => Effect.fail(mapUnaryTimeout(err))),
    );
    return runPromiseBoundary(Effect.retry(attempt, { schedule: unaryRetrySchedule, while: isRetryableUnaryError }));
  }

  /**
   * Runs the bidirectional exchange, answering the server's blob and
   * request-context queries and yielding only what the caller cares about.
   */
  private async *runStream(
    body: Uint8Array,
    blobs: BlobStore,
    signal?: AbortSignal,
  ): AsyncIterable<RunUpdate> {
    const session: ClientHttp2Session = this.connectImpl(this.baseUrl);
    const request = session.request(this.headers(RUN_PATH, 'application/connect+proto'));

    const queue: RunUpdate[] = [];
    let notify: (() => void) | undefined;
    let failure: Error | undefined;
    let finished = false;

    const wake = () => {
      notify?.();
      notify = undefined;
    };
    const push = (update: RunUpdate) => {
      queue.push(update);
      wake();
    };
    const fail = (err: Error) => {
      failure ??= err;
      finished = true;
      wake();
    };
    const finish = () => {
      finished = true;
      wake();
    };

    const send = (payload: Uint8Array) => {
      if (!request.writableEnded) request.write(Buffer.from(encodeFrame(payload)));
    };

    const abort = () => {
      request.destroy();
      fail(new ApiError('request aborted', ErrorType.InvalidRequest));
    };
    signal?.addEventListener('abort', abort, { once: true });

    session.on('error', (err) => fail(asProviderError(err)));
    request.on('error', (err) => fail(asProviderError(err)));
    request.on('response', (headers) => {
      const status = Number(headers[':status'] ?? 0);
      if (status !== 200) fail(statusError(status));
    });

    // Reassembled across data events: HTTP/2 chunks do not align to frames.
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    request.on('data', (part: Buffer) => {
      pending = concat(pending, Uint8Array.from(part));
      const { frames, rest } = readFrames(pending);
      pending = rest;
      for (const frame of frames) {
        if (frame.flags & FLAG_END_STREAM) {
          const error = endStreamError(frame.payload);
          if (error) fail(error);
          request.end();
          finish();
          return;
        }
        this.handleServerMessage(frame.payload, blobs, send, push, finish);
      }
    });
    request.on('end', finish);

    request.write(Buffer.from(encodeFrame(body)));

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as RunUpdate;
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      // Teardown as an Effect scope release: the abort listener is removed and
      // the http2 request/session are torn down together, even on interrupt.
      Effect.runSync(
        Effect.ensuring(
          Effect.sync(() => {
            request.destroy();
            session.close();
          }),
          Effect.sync(() => signal?.removeEventListener('abort', abort)),
        ),
      );
    }
  }

  /** One `AgentServerMessage`: a blob query, a context query, or an update. */
  private handleServerMessage(
    payload: Uint8Array,
    blobs: BlobStore,
    send: (payload: Uint8Array) => void,
    push: (update: RunUpdate) => void,
    finish: () => void,
  ): void {
    const message = decodeMessage(payload);

    const kv = messageField(message, 4);
    if (kv) return answerBlobQuery(kv, blobs, send);

    const exec = messageField(message, 2);
    if (exec) return answerContextQuery(exec, send);

    const update = messageField(message, 1);
    const checkpoint = bytesField(message, 3);
    if (checkpoint) return push({ kind: 'checkpoint', checkpoint });

    if (!update) return;

    const text = messageField(update, 1);
    if (text) return push({ kind: 'text', text: stringField(text, 1) });

    const thinking = messageField(update, 4);
    if (thinking) return push({ kind: 'thinking', text: stringField(thinking, 1) });

    const tokenDelta = messageField(update, 8);
    if (tokenDelta) return push({ kind: 'tokens', tokens: numberField(tokenDelta, 1) });

    // turnEnded carries no fields, so presence is the whole signal.
    if (hasField(update, 14)) finish();
  }
}

interface CursorConversation {
  checkpoint: Uint8Array;
  blobs: BlobStore;
  conversationId: string;
}

type RunUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tokens'; tokens: number }
  | { kind: 'checkpoint'; checkpoint: Uint8Array };

/**
 * Content-addressed prompt storage. Cursor keeps whatever it has seen before
 * and asks only for what it is missing, which is what makes resending a whole
 * conversation on every request affordable.
 */
export class BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  /** Stores the bytes and returns their id: the raw sha256, as the wire wants. */
  put(bytes: Uint8Array): Uint8Array {
    const digest = createHash('sha256').update(bytes).digest();
    this.blobs.set(digest.toString('hex'), bytes);
    return new Uint8Array(digest);
  }

  get(id: Uint8Array): Uint8Array | undefined {
    return this.blobs.get(Buffer.from(id).toString('hex'));
  }

  set(id: Uint8Array, bytes: Uint8Array): void {
    this.blobs.set(Buffer.from(id).toString('hex'), bytes);
  }
}

/** Answers `KvServerMessage`, which is either "send me a blob" or "hold this". */
function answerBlobQuery(
  kv: ProtoField[],
  blobs: BlobStore,
  send: (payload: Uint8Array) => void,
): void {
  const id = numberField(kv, 1);

  const getArgs = messageField(kv, 2);
  if (getArgs) {
    const blobId = bytesField(getArgs, 1) ?? new Uint8Array(0);
    const data = blobs.get(blobId);
    // GetBlobResult.blobData is optional: absent means "I do not have it",
    // which the server answers by sending it to us instead.
    const result = data ? encodeBytesField(1, data) : new Uint8Array(0);
    send(encodeMessageField(3, concat(encodeVarintField(1, id), encodeMessageField(2, result))));
    return;
  }

  const setArgs = messageField(kv, 3);
  if (setArgs) {
    const blobId = bytesField(setArgs, 1);
    const data = bytesField(setArgs, 2);
    if (blobId && data) blobs.set(blobId, data);
    send(
      encodeMessageField(
        3,
        concat(encodeVarintField(1, id), encodeMessageField(3, new Uint8Array(0))),
      ),
    );
  }
}

/**
 * Answers `ExecServerMessage`. The only query Chat can receive is
 * requestContext — the server describing-the-workspace handshake — because no
 * tools are offered. Anything else is left unanswered rather than guessed at.
 */
function answerContextQuery(exec: ProtoField[], send: (payload: Uint8Array) => void): void {
  if (!hasField(exec, 10)) return;
  const id = numberField(exec, 1);
  const execId = stringField(exec, 15);

  // RequestContextEnv, kept minimal: there is no workspace behind a chat.
  const env = concat(
    encodeStringField(1, process.platform),
    encodeStringField(3, process.env.SHELL || '/bin/sh'),
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  );
  const requestContext = encodeMessageField(4, env);
  const success = encodeMessageField(1, requestContext);
  const result = encodeMessageField(1, success);
  send(
    encodeMessageField(
      2,
      concat(encodeVarintField(1, id), encodeStringField(15, execId), encodeMessageField(10, result)),
    ),
  );
}

/**
 * Builds `AgentClientMessage{runRequest}` from an OpenAI-shaped request.
 *
 * System messages become the root prompt, everything before the final user
 * message becomes prior turns, and the final user message becomes the action.
 * A request with no trailing user message — a regeneration — sends
 * `resumeAction` instead, which asks Cursor to continue from the state given.
 */
export function buildRunRequest(
  req: ChatCompletionRequest,
  blobs: BlobStore,
  checkpoint?: Uint8Array,
  conversationId: string = randomUUID(),
): Uint8Array {
  const system = req.messages.filter((m) => m.role === 'system');
  const rest = req.messages.filter((m) => m.role !== 'system');

  // Only a message in the trailing position is a prompt. A conversation ending
  // in an assistant turn is a continuation, and sending its last user message
  // again would replay the exchange instead of extending it.
  const last = rest[rest.length - 1];
  const prompt = last?.role === 'user' ? last : undefined;
  const history = prompt ? rest.slice(0, -1) : rest;

  const conversationState = checkpoint ?? (() => {
    const rootPrompts = (system.length > 0 ? system.map(textOf) : [DEFAULT_SYSTEM_PROMPT])
      .filter((content) => content.length > 0)
      .map((content) => blobs.put(utf8(JSON.stringify({ role: 'system', content }))));
    return concat(
      ...rootPrompts.map((hash) => encodeBytesField(1, hash)),
      ...buildTurns(history, blobs).map((hash) => encodeBytesField(8, hash)),
    );
  })();

  const action = prompt
    ? encodeMessageField(1, encodeMessageField(1, encodeUserMessage(textOf(prompt))))
    : encodeMessageField(2, new Uint8Array(0)); // resumeAction

  const model = req.model;
  const modelDetails = concat(
    encodeStringField(1, model),
    encodeStringField(3, model),
    encodeStringField(4, model),
  );
  const requestedModel = concat(
    encodeStringField(1, model),
    encodeMessageField(3, concat(encodeStringField(1, 'fast'), encodeStringField(2, 'false'))),
  );

  const runRequest = concat(
    encodeMessageField(1, conversationState),
    encodeMessageField(2, action),
    encodeMessageField(3, modelDetails),
    encodeMessageField(9, requestedModel),
    encodeStringField(5, conversationId),
  );
  return encodeMessageField(1, runRequest);
}

/**
 * Prior exchanges, as Cursor stores them: each turn is a blob referencing the
 * user message and assistant steps by their own hashes, so unchanged history
 * costs nothing to resend.
 */
function buildTurns(history: Message[], blobs: BlobStore): Uint8Array[] {
  const turns: Uint8Array[] = [];
  let i = 0;
  while (i < history.length) {
    const message = history[i];
    if (!message || message.role !== 'user') {
      i++;
      continue;
    }
    const userHash = blobs.put(encodeUserMessage(textOf(message)));
    const steps: Uint8Array[] = [];
    i++;
    for (; i < history.length; i++) {
      const step = history[i];
      if (!step || step.role === 'user') break;
      if (step.role === 'assistant') {
        const reasoning = step.reasoning;
        if (reasoning) {
          steps.push(blobs.put(encodeMessageField(3, encodeStringField(1, reasoning))));
        }
        const content = textOf(step);
        if (content) {
          steps.push(blobs.put(encodeMessageField(1, encodeStringField(1, content))));
        }
      }
    }
    const turn = concat(
      encodeBytesField(1, userHash),
      ...steps.map((hash) => encodeBytesField(2, hash)),
    );
    turns.push(blobs.put(encodeMessageField(1, turn)));
  }
  return turns;
}

function encodeUserMessage(text: string): Uint8Array {
  return concat(encodeStringField(1, text), encodeStringField(2, randomUUID()));
}

/** Multi-part content is flattened to its text; Cursor's chat action is text-only. */
function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

function priorMessages(messages: Message[]): Message[] {
  return messages[messages.length - 1]?.role === 'user' ? messages.slice(0, -1) : messages;
}

function conversationKey(model: string, messages: Message[]): string {
  // Cursor's reasoning is private transport state: OpenAI-compatible clients
  // replay only the visible transcript. The checkpoint already contains that
  // reasoning, so including it here makes every reasoning turn miss its cache.
  const transcript = messages.map((message) => ({
    role: message.role,
    content: textOf(message),
  }));
  return createHash('sha256').update(JSON.stringify([model, transcript])).digest('hex');
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** The end-of-stream frame is JSON even though everything before it is protobuf. */
function endStreamError(payload: Uint8Array): ApiError | undefined {
  if (payload.length === 0) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as {
      error?: { code?: string; message?: string };
    };
    if (!parsed.error) return undefined;
    const code = parsed.error.code ?? 'unknown';
    const message = parsed.error.message ?? 'unknown error';
    return new ApiError(
      `cursor: ${code}: ${message}`,
      code === 'resource_exhausted' ? ErrorType.RateLimit : ErrorType.Server,
    );
  } catch {
    return new ApiError('cursor: malformed end-of-stream frame', ErrorType.Server);
  }
}

function statusError(status: number): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError('cursor: access token rejected', ErrorType.Authentication);
  }
  if (status === 429) return new ApiError('cursor: rate limited', ErrorType.RateLimit);
  return new ApiError(`cursor: upstream returned ${status}`, ErrorType.Server);
}

function asProviderError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(`cursor: ${message}`, ErrorType.Server);
}
