/**
 * LLM-based request classification. Ported from routing/classifier.go.
 *
 * lastUserMessage is defined in routing/embeddings.go in Go, but classifier.go
 * depends on it and the classifier is on the live path (unlike the embedding
 * layer), so it is ported here rather than left out with the rest of
 * embeddings.go.
 */

import { Cause, Data, Effect, Schedule } from 'effect';
import { LRUCache, hashKey } from './cache.js';
import type { ClassifierConfig, RouteConfig } from './config.js';
import type { RequestInfo } from './routing.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../providers/types.js';

interface ClassifiedResult {
  route: string;
  confidence: number;
}

/** Machine-readable cause of a classification failure. */
export type ClassifierFailureReason =
  | 'request-failed'
  | 'read-body'
  | 'bad-status'
  | 'bad-payload'
  | 'no-choices'
  | 'non-text-content'
  | 'unknown-category';

/**
 * Typed classifier failure. `reason` distinguishes transient transport faults
 * (`request-failed`, retried below) from permanent ones (bad payload, unknown
 * category — never retried); `cause` keeps the original error for debugging.
 */
export class ClassifierError extends Data.TaggedError('ClassifierError')<{
  readonly reason: ClassifierFailureReason;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/**
 * Retry policy for the classifier fetch: exponential backoff capped at two
 * retries. Only transport-level failures are retried (see
 * `isRetryableFetchError`); HTTP error statuses and malformed payloads fail
 * fast with their typed error.
 */
const classifierFetchRetry = Schedule.intersect(
  Schedule.exponential('50 millis'),
  Schedule.recurs(2),
);

/** Retries transport faults, never aborts-in-flight, validation, or HTTP statuses. */
function isRetryableFetchError(error: ClassifierError, signal: AbortSignal | undefined): boolean {
  if (error.reason !== 'request-failed') return false;
  if (signal?.aborted) return false;
  const cause = error.cause;
  return !(cause instanceof Error && cause.name === 'AbortError');
}

export interface ClassifierMatcherOptions {
  baseUrl: string;
  apiKey: string;
  /** Injected for tests, and for backends reached over a tunnelled transport. */
  fetchImpl?: typeof fetch;
}

/** Performs LLM-based request classification. */
export class ClassifierMatcher {
  private readonly cfg: ClassifierConfig;
  private readonly routes: RouteConfig[];
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: LRUCache<ClassifiedResult> | undefined;

  constructor(cfg: ClassifierConfig, routes: RouteConfig[], options: ClassifierMatcherOptions) {
    this.cfg = cfg;
    this.routes = routes;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cache = initClassifierCache(cfg);
  }

  /**
   * Effect core of classification: fails with a typed `ClassifierError`
   * instead of throwing, and retries transient fetch faults with exponential
   * backoff. The LRU fast-path stays synchronous — a cache hit performs no IO.
   */
  classifyEffect(info: RequestInfo, signal?: AbortSignal): Effect.Effect<ClassifiedResult, ClassifierError> {
    let cacheKey = '';
    if (this.cache) {
      const userMsg = lastUserMessage(info);
      if (userMsg !== '') {
        cacheKey = hashKey(userMsg);
        const cached = this.cache.get(cacheKey);
        if (cached.ok && cached.value) return Effect.succeed(cached.value);
      }
    }

    const effectiveSignal = this.combineSignal(signal);
    const prompt = this.buildPrompt(info);

    const reqBody: ChatCompletionRequest = {
      model: this.cfg.model,
      messages: [{ role: 'user', content: prompt }],
    };

    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };

    const fetchEffect = Effect.tryPromise({
      try: async () =>
        this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
          signal: effectiveSignal,
        }),
      catch: (cause) =>
        new ClassifierError({
          reason: 'request-failed',
          message: `classifier request failed: ${errMessage(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.retry({
        schedule: classifierFetchRetry,
        while: (error) => isRetryableFetchError(error, effectiveSignal),
      }),
    );

    return fetchEffect.pipe(
      Effect.flatMap((res) => this.readBodyEffect(res)),
      Effect.flatMap(({ res, respBody }) => this.parseResponseEffect(res, respBody, cacheKey)),
    );
  }

  /**
   * Promise compatibility boundary: same signature and rejection behavior as
   * before — rejects with the raw `ClassifierError` (an `Error`), never a
   * `FiberFailure` wrapper.
   */
  async classify(info: RequestInfo, signal?: AbortSignal): Promise<ClassifiedResult> {
    const exit = await Effect.runPromiseExit(this.classifyEffect(info, signal));
    if (exit._tag === 'Failure') throw Cause.squash(exit.cause);
    return exit.value;
  }

  /** Reads the response body; a truncated body is a typed `read-body` failure. */
  private readBodyEffect(res: Response): Effect.Effect<{ res: Response; respBody: string }, ClassifierError> {
    return Effect.tryPromise({
      try: async () => ({ res, respBody: await res.text() }),
      catch: (cause) =>
        new ClassifierError({
          reason: 'read-body',
          message: `failed to read classifier response: ${errMessage(cause)}`,
          cause,
        }),
    });
  }

  /**
   * Validates status, decodes the chat payload, and resolves the category
   * against the known routes. Every rejection mode is a typed failure —
   * nothing here throws.
   */
  private parseResponseEffect(
    res: Response,
    respBody: string,
    cacheKey: string,
  ): Effect.Effect<ClassifiedResult, ClassifierError> {
    // Go checks the exact 200 status, not the broader ok range.
    if (res.status !== 200) {
      return Effect.fail(
        new ClassifierError({
          reason: 'bad-status',
          message: `classifier error ${res.status}: ${respBody}`,
          status: res.status,
        }),
      );
    }

    return Effect.try({
      try: () => JSON.parse(respBody) as ChatCompletionResponse,
      catch: (cause) =>
        new ClassifierError({
          reason: 'bad-payload',
          message: `failed to unmarshal classifier response: ${errMessage(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap((chatResp) => {
        const choice = chatResp.choices?.[0];
        if (!choice || !choice.message) {
          return Effect.fail(
            new ClassifierError({ reason: 'no-choices', message: 'classifier returned no choices' }),
          );
        }

        // the classifier prompt asks for a plain-text JSON reply, so content
        // is a string; anything else is an unusable response.
        const rawContent = choice.message.content;
        if (typeof rawContent !== 'string') {
          return Effect.fail(
            new ClassifierError({
              reason: 'non-text-content',
              message: 'classifier returned non-text content',
            }),
          );
        }

        // extract JSON from the response (may be wrapped in markdown code blocks)
        const content = extractJSON(rawContent);
        return Effect.try({
          try: () => JSON.parse(content) as { category: string; confidence: number },
          catch: (cause) =>
            new ClassifierError({
              reason: 'bad-payload',
              message: `failed to parse classifier output '${content}': ${errMessage(cause)}`,
              cause,
            }),
        });
      }),
      Effect.flatMap((result) => {
        // validate the category is a known route
        for (const r of this.routes) {
          if (r.name.toLowerCase() === result.category.toLowerCase()) {
            const classified = { route: r.name, confidence: result.confidence };
            if (this.cache && cacheKey !== '') {
              this.cache.put(cacheKey, classified);
            }
            return Effect.succeed(classified);
          }
        }
        return Effect.fail(
          new ClassifierError({
            reason: 'unknown-category',
            message: `classifier returned unknown category '${result.category}'`,
          }),
        );
      }),
    );
  }

  buildPrompt(info: RequestInfo): string {
    const instruction = (this.cfg.prompt ?? '').trim() || 'Classify the following user request into one of these categories.';
    let b = `${instruction}\n\n`;
    b += 'Categories:\n';
    for (const r of this.routes) {
      b += `- ${r.name}: ${r.description ?? ''}\n`;
    }
    b += '\nUser request:\n';
    const prompt = lastUserMessage(info);
    if (prompt !== '') b += prompt;
    b += '\n\nRespond with JSON only: {"category": "<name>", "confidence": <0.0-1.0>}';
    return b;
  }

  /** AbortSignal.timeout is already unref'd internally, so no manual timer to clean up. */
  private combineSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (!this.cfg.timeoutMs || this.cfg.timeoutMs <= 0) return signal;
    const timeoutSignal = AbortSignal.timeout(this.cfg.timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  }
}

function initClassifierCache(cfg: ClassifierConfig): LRUCache<ClassifiedResult> | undefined {
  if (!cfg.cacheResults) return undefined;
  const ttl = cfg.cacheTtl && cfg.cacheTtl > 0 ? cfg.cacheTtl : 3600;
  const size = cfg.cacheSize && cfg.cacheSize > 0 ? cfg.cacheSize : 500;
  return new LRUCache<ClassifiedResult>(size, ttl * 1000);
}

export function lastUserMessage(info: RequestInfo): string {
  for (let i = info.messages.length - 1; i >= 0; i--) {
    const msg = info.messages[i];
    if (msg && msg.role.toLowerCase() === 'user') return msg.content;
  }
  return '';
}

/** Strips markdown code block wrappers from JSON content. */
function extractJSON(s: string): string {
  s = s.trim();
  if (s.startsWith('```json')) {
    s = s.slice('```json'.length);
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.trim();
  } else if (s.startsWith('```')) {
    s = s.slice(3);
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.trim();
  }
  return s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
