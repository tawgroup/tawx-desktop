/**
 * Anthropic provider. Ported from providers/anthropic.go.
 *
 * translates OpenAI-format requests to Anthropic's format. the translation
 * helpers below (translateRequest, convertAssistantMessage, translateTools,
 * translateToolChoice, extractContent, translateResponse, translateStopReason)
 * and readSSEStream are left as regular (public) methods rather than
 * `private`/`protected` so the ported Go tests — which called the equivalent
 * unexported package-private methods directly — can do the same here.
 */

import { Effect, Schedule, Stream } from 'effect';
import { ApiError, ErrorType, asApiError, runPromiseBoundary, type ErrorTypeValue } from './errors.js';
import { readSseDataStream } from './streaming.js';
import type { Provider } from './provider.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Delta,
  Message,
  Model,
  StreamChunk,
  Tool,
  ToolCall,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

const UPSTREAM_TIMEOUT = '30 seconds' as const;
const upstreamRetrySchedule = Schedule.intersect(Schedule.exponential('200 millis'), Schedule.recurs(2));

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  if (isAbortLike(err)) return false;
  if ((err as { _tag?: string })?._tag === 'TimeoutException') return false;
  return err instanceof TypeError;
}

function mapTimeout(err: unknown): unknown {
  if ((err as { _tag?: string })?._tag === 'TimeoutException') {
    return new ApiError('upstream request timed out', ErrorType.Server);
  }
  return err;
}

/**
 * Interruptible fetch: the Effect runtime's AbortSignal joins the caller's so
 * either side aborts the request, Effect.timeout bounds it, and Effect.retry
 * replays transient transport failures only. Transport errors stay raw,
 * exactly as before.
 */
function fetchUpstreamEffect(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  outerSignal?: AbortSignal,
): Effect.Effect<Response, unknown> {
  const attempt = Effect.tryPromise({
    try: (abortSignal) =>
      fetchImpl(url, {
        ...init,
        signal: outerSignal ? AbortSignal.any([outerSignal, abortSignal]) : abortSignal,
      }),
    catch: (err) => err,
  }).pipe(
    Effect.timeout(UPSTREAM_TIMEOUT),
    Effect.catchAll((err) => Effect.fail(mapTimeout(err))),
  );
  return Effect.retry(attempt, { schedule: upstreamRetrySchedule, while: isRetryableFetchError });
}

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected for tests and for providers that tunnel through a proxy. */
  fetchImpl?: typeof fetch;
}

// anthropic request/response types (wire shapes, snake_case to match the API directly)

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

/** InputSchema holds the JSON schema (equivalent to OpenAI's function.parameters). */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

/** {"type":"auto"}, {"type":"any"}, or {"type":"tool","name":"X"}. */
export interface AnthropicToolChoice {
  type: string;
  name?: string;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

/**
 * AnthropicContentBlock serves three roles: request tool_use blocks (built from
 * assistant tool_calls), request tool_result blocks (built from tool messages),
 * and response blocks (text or tool_use) read back from Anthropic. every
 * optional field is left undefined when unused so it drops out of the wire
 * format via JSON.stringify.
 */
export interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: AnthropicSource;
  // tool_use (assistant request blocks, and response blocks)
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result (user request blocks)
  tool_use_id?: string;
  content?: unknown; // string or block[]; we emit a string
}

export interface AnthropicSource {
  type: string;
  media_type: string;
  data: string;
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

// anthropic streaming event types

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: AnthropicDelta;
  message?: { id?: string };
  error?: AnthropicStreamError;
}

/** the payload of a streaming `type: "error"` event (e.g. overloaded_error, rate_limit_error mid-stream). */
export interface AnthropicStreamError {
  type?: string;
  message?: string;
}

export interface AnthropicDelta {
  type?: string;
  text?: string;
  partial_json?: string;
  stop_reason?: string;
}

/** reports whether an OpenAI function.parameters value carries no usable schema (nil, an empty object, or an empty string). */
function isEmptySchema(schema: unknown): boolean {
  if (schema === null || schema === undefined) return true;
  if (typeof schema === 'string') return schema === '';
  if (typeof schema === 'object' && !Array.isArray(schema)) {
    return Object.keys(schema as Record<string, unknown>).length === 0;
  }
  return false;
}

export class AnthropicProvider implements Provider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async chatCompletion(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const program = Effect.gen(this, function* () {
      const ar = this.translateRequest(req);
      // stream left unset (omitted from the wire): anthropic defaults to
      // non-streaming, matching Go's `Stream bool ,omitempty` dropping `false`.

      const res = yield* fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(ar),
      }, signal);

      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (err) => err,
      });
      if (!res.ok) return yield* Effect.fail(this.parseError(res.status, text));

      const anthropicResp = yield* Effect.try({
        try: () => JSON.parse(text) as AnthropicResponse,
        catch: (err) =>
          new ApiError(
            `failed to unmarshal response: ${err instanceof Error ? err.message : String(err)}`,
            ErrorType.Server,
          ),
      });

      return this.translateResponse(anthropicResp, req.model);
    });
    return runPromiseBoundary(program);
  }

  async *chatCompletionStream(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const ar = this.translateRequest(req);
    ar.stream = true;

    const res = await runPromiseBoundary(
      fetchUpstreamEffect(this.fetchImpl, `${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.headers({ Accept: 'text/event-stream' }),
        body: JSON.stringify(ar),
      }, signal),
    );

    if (!res.ok) throw this.parseError(res.status, await res.text());
    if (!res.body) throw new ApiError('upstream returned no body', ErrorType.Server);

    yield* this.readSSEStream(res.body, req.model);
  }

  /**
   * Reads an Anthropic SSE body and yields OpenAI-shaped StreamChunks. Ends
   * normally on message_stop (or when the body is exhausted) instead of
   * signalling Done, and throws ApiError instead of carrying Err.
   */
  async *readSSEStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    let messageId = '';
    const created = Math.floor(Date.now() / 1000);

    // streaming tool-call state: anthropic interleaves text and tool_use blocks
    // in a single content-block index space, but OpenAI tool_call indices count
    // only tool calls. map anthropic block index -> OpenAI tool_call index so a
    // call's index stays stable across its argument fragments.
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;

    const makeChunk = (delta: Delta, finishReason: string | null): StreamChunk => ({
      id: messageId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    try {
      const events = Stream.mapEffect(readSseDataStream(body), (data) =>
        Effect.try({
          try: () => JSON.parse(data) as AnthropicStreamEvent,
          catch: (err) =>
            new ApiError(
              `failed to parse event: ${err instanceof Error ? err.message : String(err)}`,
              ErrorType.Server,
            ),
        }),
      );
      for await (const event of Stream.toAsyncIterable(events)) {

        const index = event.index ?? 0;

        switch (event.type) {
          case 'message_start':
            if (event.message?.id) messageId = event.message.id;
            break;

          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              const idx = nextToolIndex;
              toolIndexByBlock.set(index, idx);
              nextToolIndex++;
              // opening tool chunk: index + id + type + name, empty arguments
              yield makeChunk(
                {
                  tool_calls: [
                    {
                      index: idx,
                      id: event.content_block.id,
                      type: 'function',
                      function: { name: event.content_block.name },
                    },
                  ],
                },
                null,
              );
            }
            break;

          case 'content_block_delta': {
            if (!event.delta) break;
            if (event.delta.type === 'input_json_delta') {
              const idx = toolIndexByBlock.get(index);
              if (idx === undefined || !event.delta.partial_json) break;
              // argument fragment: index + arguments only
              yield makeChunk(
                { tool_calls: [{ index: idx, function: { arguments: event.delta.partial_json } }] },
                null,
              );
            } else if (event.delta.text) {
              yield makeChunk({ content: event.delta.text }, null);
            }
            break;
          }

          case 'message_delta':
            if (event.delta?.stop_reason) {
              yield makeChunk({}, this.translateStopReason(event.delta.stop_reason));
            }
            break;

          case 'error': {
            // surface a mid-stream upstream error as a thrown ApiError so the
            // caller sees the failure instead of a silently truncated stream.
            const upstream = event.error?.message;
            const msg = upstream ? `anthropic stream error: ${upstream}` : 'anthropic stream error';
            throw new ApiError(msg, ErrorType.Server);
          }

          case 'message_stop':
            return;
        }
      }
    } catch (err) {
      throw asApiError(err);
    }
  }

  async listModels(_signal?: AbortSignal): Promise<Model[]> {
    // anthropic doesn't have a public models list endpoint, return static list.
    // current models listed first, then legacy models still available via the API.
    // see https://docs.anthropic.com/en/docs/about-claude/models/overview
    return [
      // current models
      { id: 'claude-opus-4-6', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-6', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', object: 'model', created: 0, owned_by: 'anthropic' },
      // legacy models
      { id: 'claude-sonnet-4-5-20250929', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-opus-4-5-20251101', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-opus-4-1-20250805', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-20250514', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-3-7-sonnet-20250219', object: 'model', created: 0, owned_by: 'anthropic' },
      { id: 'claude-3-haiku-20240307', object: 'model', created: 0, owned_by: 'anthropic' },
    ];
  }

  translateRequest(req: ChatCompletionRequest): AnthropicRequest {
    const ar: AnthropicRequest = {
      model: req.model,
      max_tokens: req.max_tokens ?? 4096, // anthropic requires max_tokens
      messages: [],
      temperature: req.temperature,
      top_p: req.top_p,
    };

    // handle stop sequences
    if (req.stop !== undefined) {
      if (typeof req.stop === 'string') {
        ar.stop_sequences = [req.stop];
      } else if (Array.isArray(req.stop)) {
        const seqs = (req.stop as unknown[]).filter((s): s is string => typeof s === 'string');
        if (seqs.length > 0) ar.stop_sequences = seqs;
      }
    }

    // extract system message and convert messages. tool-role messages become
    // anthropic tool_result blocks; consecutive ones coalesce into a single
    // user message (anthropic requires tool_results grouped at the start of the
    // user turn that follows the assistant tool_use turn).
    let pending: AnthropicContentBlock[] = [];
    const flush = () => {
      if (pending.length > 0) {
        ar.messages.push({ role: 'user', content: pending });
        pending = [];
      }
    };

    for (const msg of req.messages) {
      switch (msg.role) {
        case 'system':
          // anthropic uses a separate system field
          ar.system = this.extractContent(msg.content) || undefined;
          break;
        case 'tool':
          pending.push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: this.extractContent(msg.content),
          });
          break;
        case 'assistant':
          flush();
          ar.messages.push(this.convertAssistantMessage(msg));
          break;
        default: // "user"
          flush();
          ar.messages.push({ role: 'user', content: this.extractContent(msg.content) });
          break;
      }
    }
    flush();

    // translate tools and tool_choice. tool_choice "none" drops tools entirely
    // (anthropic has no direct equivalent).
    const [choice, dropTools] = this.translateToolChoice(req.tool_choice);
    if (!dropTools && req.tools && req.tools.length > 0) {
      ar.tools = this.translateTools(req.tools);
      ar.tool_choice = choice;
    }

    return ar;
  }

  /**
   * Converts an OpenAI assistant message into an anthropic message. when the
   * assistant made tool calls, its content becomes an array of blocks: an
   * optional leading text block followed by one tool_use block per call.
   */
  convertAssistantMessage(msg: Message): AnthropicMessage {
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { role: 'assistant', content: this.extractContent(msg.content) };
    }

    const blocks: AnthropicContentBlock[] = [];
    const text = this.extractContent(msg.content);
    if (text) blocks.push({ type: 'text', text });

    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      const argsStr = tc.function.arguments;
      if (argsStr) {
        try {
          input = JSON.parse(argsStr);
        } catch {
          input = {};
        }
      }
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }

    return { role: 'assistant', content: blocks };
  }

  /**
   * Maps OpenAI function tools to anthropic tools. non-function tools are
   * skipped; nil/empty parameters default to an empty object schema.
   */
  translateTools(tools: Tool[]): AnthropicTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const out: AnthropicTool[] = [];
    for (const t of tools) {
      if (t.type !== '' && t.type !== 'function') continue;
      let schema = t.function?.parameters;
      if (isEmptySchema(schema)) schema = { type: 'object', properties: {} };
      out.push({ name: t.function?.name ?? '', description: t.function?.description, input_schema: schema });
    }
    return out;
  }

  /**
   * Maps OpenAI tool_choice to anthropic's tool_choice object. returns
   * dropTools=true for "none", signalling that tools should be omitted from
   * the request (anthropic has no direct "none" equivalent).
   */
  translateToolChoice(tc: unknown): [AnthropicToolChoice | undefined, boolean] {
    if (tc === undefined || tc === null) return [undefined, false];

    if (typeof tc === 'string') {
      switch (tc) {
        case 'auto':
          return [{ type: 'auto' }, false];
        case 'required':
          return [{ type: 'any' }, false];
        case 'none':
          return [undefined, true];
        default:
          return [undefined, false];
      }
    }

    if (typeof tc === 'object') {
      // {"type":"function","function":{"name":"X"}}
      const v = tc as Record<string, unknown>;
      const fn = v.function;
      if (fn && typeof fn === 'object') {
        const name = (fn as Record<string, unknown>).name;
        if (typeof name === 'string') return [{ type: 'tool', name }, false];
      }
      return [undefined, false];
    }

    return [undefined, false];
  }

  extractContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          parts.push((part as Record<string, unknown>).text as string);
        }
      }
      return parts.join('\n');
    }
    return '';
  }

  translateResponse(resp: AnthropicResponse, model: string): ChatCompletionResponse {
    // collect text and tool_use blocks
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const block of resp.content) {
      if (block.type === 'text') {
        content += block.text ?? '';
      } else if (block.type === 'tool_use') {
        const args = block.input === undefined ? '{}' : JSON.stringify(block.input);
        toolCalls.push({ id: block.id ?? '', type: 'function', function: { name: block.name ?? '', arguments: args } });
      }
    }

    const msg: Message = { role: 'assistant', content: '' };
    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
      // match OpenAI: content is null when only tool calls are present
      msg.content = content.length > 0 ? content : null;
    } else {
      msg.content = content;
    }

    const finishReason = this.translateStopReason(resp.stop_reason);
    return {
      id: resp.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: msg, finish_reason: finishReason }],
      usage: {
        prompt_tokens: resp.usage.input_tokens,
        completion_tokens: resp.usage.output_tokens,
        total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
      },
    };
  }

  translateStopReason(reason: string): string {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      default:
        return reason;
    }
  }

  private parseError(statusCode: number, body: string): ApiError {
    try {
      const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
      if (parsed?.error?.message) {
        let errType: ErrorTypeValue = ErrorType.Server;
        switch (parsed.error.type) {
          case 'authentication_error':
            errType = ErrorType.Authentication;
            break;
          case 'rate_limit_error':
            errType = ErrorType.RateLimit;
            break;
          case 'invalid_request_error':
            errType = ErrorType.InvalidRequest;
            break;
          case 'not_found_error':
            errType = ErrorType.NotFound;
            break;
        }
        return new ApiError(parsed.error.message, errType);
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
        // keep the native upstream body out of the client-facing error; log it
        // for diagnostics and return a generic OpenAI-shaped server error.
        console.error(`anthropic API error (status ${statusCode}): ${body}`);
        return new ApiError(`Anthropic API error (status ${statusCode})`, ErrorType.Server);
    }
  }
}
