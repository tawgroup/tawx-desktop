/**
 * Provider kinds — the one place a vendor gets wired in.
 *
 * This vocabulary is shared with the frontend's `ProviderKind` (see
 * frontend/src/types.ts), which already tags every configured provider with a
 * kind but so far only used it to pick a display label. These constructors are
 * what that tag dispatches to.
 *
 * Adding a vendor is: write the adapter, add one entry below. Nothing else in
 * the codebase should branch on vendor identity.
 */

import { AnthropicProvider } from './anthropic.js';
import { CursorProvider } from './cursor.js';
import { ApiError, ErrorType } from './errors.js';
import { GoogleProvider } from './google.js';
import { LocalProvider } from './local.js';
import { OpenAiProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import type { Provider } from './provider.js';

export const ProviderKind = {
  /** OpenAI and every vendor that copies its wire format: DeepSeek, Groq, Together, LM Studio. */
  OpenAiCompatible: 'openai-compatible',
  Google: 'google',
  OpenRouter: 'openrouter',
  Anthropic: 'anthropic',
  /** A Cursor subscription, reached over its own protobuf agent protocol. */
  Cursor: 'cursor',
  /** OpenAI-compatible but unauthenticated, with /api/tags as the model-list fallback. */
  Ollama: 'ollama',
} as const;

export type ProviderKindValue = (typeof ProviderKind)[keyof typeof ProviderKind];

export interface ProviderSpec {
  baseUrl?: string;
  apiKey?: string;
  /** Injected by tests and by tunnelled transports. */
  fetchImpl?: typeof fetch;
}

export type ProviderConstructor = (spec: ProviderSpec) => Provider;

/**
 * A plain record rather than a mutable `register()` registry: adding an entry
 * is just as easy, the set is knowable at compile time, and no import-order
 * accident can leave a kind missing at runtime.
 */
export const PROVIDER_KINDS: Record<ProviderKindValue, ProviderConstructor> = {
  [ProviderKind.OpenAiCompatible]: (spec) =>
    new OpenAiProvider({ apiKey: spec.apiKey ?? '', baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl }),
  [ProviderKind.Google]: (spec) =>
    new GoogleProvider({ apiKey: spec.apiKey ?? '', baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl }),
  [ProviderKind.OpenRouter]: (spec) =>
    new OpenRouterProvider({ apiKey: spec.apiKey ?? '', baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl }),
  [ProviderKind.Anthropic]: (spec) =>
    new AnthropicProvider({ apiKey: spec.apiKey ?? '', baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl }),
  [ProviderKind.Cursor]: (spec) =>
    new CursorProvider({ apiKey: spec.apiKey ?? '', baseUrl: spec.baseUrl }),
  [ProviderKind.Ollama]: (spec) => new LocalProvider({ baseUrl: spec.baseUrl, fetchImpl: spec.fetchImpl }),
};

export function createProvider(kind: string, spec: ProviderSpec): Provider {
  const construct = PROVIDER_KINDS[kind as ProviderKindValue];
  if (!construct) {
    throw new ApiError(`unknown provider kind '${kind}'`, ErrorType.InvalidRequest);
  }
  return construct(spec);
}

export function providerKinds(): ProviderKindValue[] {
  return Object.keys(PROVIDER_KINDS) as ProviderKindValue[];
}
