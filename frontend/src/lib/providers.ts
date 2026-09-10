import type { ModelInfo, Provider, ProviderAuthKind, ProviderKind } from '../types.ts';

export interface ProviderPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  authKind: ProviderAuthKind;
  model: string;
}

export interface ModelRoute {
  key: string;
  providerId: string;
  providerName: string;
  model: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', authKind: 'bearer', model: 'openai/gpt-4o-mini' },
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', authKind: 'bearer', model: 'gpt-4o-mini' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', authKind: 'bearer', model: 'deepseek-chat' },
  { id: 'google', name: 'Google Gemini', kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', authKind: 'bearer', model: 'gemini-3.1-flash-lite' },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', authKind: 'bearer', model: 'llama-3.3-70b-versatile' },
  { id: 'together', name: 'Together AI', kind: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', authKind: 'bearer', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'ollama', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', authKind: 'none', model: 'llama3.2' },
  { id: 'lm-studio', name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', authKind: 'none', model: 'local-model' },
];
export function visionModelIds(models: readonly ModelInfo[]): string[] {
  return models
    .filter((model) => model.architecture?.input_modalities?.includes('image'))
    .map((model) => model.id);
}

function inferKind(baseUrl: string, id: string): ProviderKind {
  if (id === 'gateway' || baseUrl.startsWith('/')) return 'gateway';
  if (baseUrl.includes('openrouter.ai')) return 'openrouter';
  if (id === 'google' || baseUrl.includes('generativelanguage.googleapis.com')) return 'google';
  if (baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434')) return 'ollama';
  return 'openai-compatible';
}

export function normalizeProvider(provider: Partial<Provider> & Pick<Provider, 'id' | 'name' | 'baseUrl' | 'apiKey' | 'model'>): Provider {
  const kind = provider.kind ?? inferKind(provider.baseUrl, provider.id);
  const discoveredModels = Array.from(new Set([...(provider.discoveredModels ?? []), provider.model].filter(Boolean)));
  const visionModels = Array.from(new Set(provider.visionModels ?? []));
  return {
    ...provider,
    kind,
    authKind: provider.authKind ?? (kind === 'gateway' || kind === 'ollama' || !provider.apiKey ? 'none' : 'bearer'),
    enabled: provider.enabled ?? true,
    discoveredModels,
    visionModels,
    connectionStatus: provider.connectionStatus ?? (kind === 'gateway' ? 'connected' : 'untested'),
  };
}

/**
 * OpenRouter is the only upstream that runs a web search for us, and it is
 * reached two ways: as a provider of its own kind, or through the gateway's
 * `openrouter/<model>` selector. Both spellings have to count — the toggle in
 * the composer and the request built in useChats read this one predicate, or
 * the button lights up for a provider whose requests never carry the tool.
 */
export function supportsWebSearch(kind: ProviderKind, model: string): boolean {
  return kind === 'openrouter' || model.startsWith('openrouter/');
}

export function isProviderRoutable(provider: Provider): boolean {
  if (!provider.enabled) return false;
  // A managed provider's key is held by the main process, so `apiKey` is always
  // empty here; `hasApiKey` is what says whether one exists.
  if (provider.ownership === 'managed') {
    return provider.authKind === 'none' || provider.hasApiKey === true;
  }
  return provider.authKind === 'none' || provider.apiKey.trim().length > 0;
}

/**
 * Rewrites a managed provider into a gateway call.
 *
 * The renderer stops being a provider client: the base URL becomes this
 * server's own `/v1`, no key is attached, and the provider is named inside the
 * model as `<providerId>/<model>` — the selector the gateway's Router splits.
 * A local provider is returned unchanged and is still called directly.
 */
export function resolveProviderCall(provider: Provider): Provider {
  if (provider.ownership !== 'managed') return provider;
  return {
    ...provider,
    baseUrl: '/v1',
    billingBaseUrl: provider.baseUrl,
    authKind: 'none',
    apiKey: '',
    model: qualifyModel(provider.id, provider.model),
    discoveredModels: provider.discoveredModels.map((model) => qualifyModel(provider.id, model)),
  };
}

/** `deepseek` + `deepseek-chat` → `deepseek/deepseek-chat`, idempotently. */
export function qualifyModel(providerId: string, model: string): string {
  if (!model) return model;
  return model.startsWith(`${providerId}/`) ? model : `${providerId}/${model}`;
}

export function validateProviderBaseUrl(baseUrl: string): string | null {
  const value = baseUrl.trim();
  if (value.startsWith('/')) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return null;
    return 'Use HTTPS for remote providers. HTTP is allowed only for localhost.';
  } catch {
    return 'Enter a valid provider URL.';
  }
}

export function normalizeProviders(providers: Provider[]): Provider[] {
  return providers.map(normalizeProvider);
}

export function modelRoutes(providers: Provider[]): ModelRoute[] {
  return providers
    .filter(isProviderRoutable)
    .flatMap((provider) => {
      const models = Array.from(new Set([provider.model, ...provider.discoveredModels].filter(Boolean)));
      return models.map((model) => ({
        key: `${provider.id}:${model}`,
        providerId: provider.id,
        providerName: provider.name,
        model,
      }));
    });
}

export function providerKindLabel(kind: ProviderKind): string {
  switch (kind) {
    case 'gateway': return 'Managed gateway';
    case 'openrouter': return 'OpenRouter';
    case 'google': return 'Google Gemini';
    case 'ollama': return 'Ollama';
    case 'anthropic': return 'Anthropic';
    default: return 'OpenAI-compatible';
  }
}
