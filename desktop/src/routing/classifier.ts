/**
 * LLM-based request classification. Ported from routing/classifier.go.
 *
 * lastUserMessage is defined in routing/embeddings.go in Go, but classifier.go
 * depends on it and the classifier is on the live path (unlike the embedding
 * layer), so it is ported here rather than left out with the rest of
 * embeddings.go.
 */

import { LRUCache, hashKey } from './cache.js';
import type { ClassifierConfig, RouteConfig } from './config.js';
import type { RequestInfo } from './routing.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../providers/types.js';

interface ClassifiedResult {
  route: string;
  confidence: number;
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

  /** Sends the request to an LLM for classification and returns the route and confidence. */
  async classify(info: RequestInfo, signal?: AbortSignal): Promise<ClassifiedResult> {
    let cacheKey = '';
    if (this.cache) {
      const userMsg = lastUserMessage(info);
      if (userMsg !== '') {
        cacheKey = hashKey(userMsg);
        const cached = this.cache.get(cacheKey);
        if (cached.ok && cached.value) return cached.value;
      }
    }

    const effectiveSignal = this.combineSignal(signal);
    const prompt = this.buildPrompt(info);

    const reqBody: ChatCompletionRequest = {
      model: this.cfg.model,
      messages: [{ role: 'user', content: prompt }],
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(reqBody),
        signal: effectiveSignal,
      });
    } catch (err) {
      throw new Error(`classifier request failed: ${errMessage(err)}`);
    }

    let respBody: string;
    try {
      respBody = await res.text();
    } catch (err) {
      throw new Error(`failed to read classifier response: ${errMessage(err)}`);
    }

    // Go checks the exact 200 status, not the broader ok range.
    if (res.status !== 200) {
      throw new Error(`classifier error ${res.status}: ${respBody}`);
    }

    let chatResp: ChatCompletionResponse;
    try {
      chatResp = JSON.parse(respBody) as ChatCompletionResponse;
    } catch (err) {
      throw new Error(`failed to unmarshal classifier response: ${errMessage(err)}`);
    }

    const choice = chatResp.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error('classifier returned no choices');
    }

    // the classifier prompt asks for a plain-text JSON reply, so content is a
    // string; anything else is an unusable response.
    const rawContent = choice.message.content;
    if (typeof rawContent !== 'string') {
      throw new Error('classifier returned non-text content');
    }

    // extract JSON from the response (may be wrapped in markdown code blocks)
    const content = extractJSON(rawContent);

    let result: { category: string; confidence: number };
    try {
      result = JSON.parse(content) as { category: string; confidence: number };
    } catch (err) {
      throw new Error(`failed to parse classifier output '${content}': ${errMessage(err)}`);
    }

    // validate the category is a known route
    for (const r of this.routes) {
      if (r.name.toLowerCase() === result.category.toLowerCase()) {
        if (this.cache && cacheKey !== '') {
          this.cache.put(cacheKey, { route: r.name, confidence: result.confidence });
        }
        return { route: r.name, confidence: result.confidence };
      }
    }

    throw new Error(`classifier returned unknown category '${result.category}'`);
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
