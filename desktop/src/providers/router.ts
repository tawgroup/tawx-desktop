/** Model-name to provider routing. Ported from providers/router.go. */

import { ApiError, ErrorType } from './errors.js';
import type { Provider } from './provider.js';

export const ProviderType = {
  OpenAi: 'openai',
  OpenRouter: 'openrouter',
  Anthropic: 'anthropic',
  Local: 'local',
} as const;

export type ProviderTypeValue = (typeof ProviderType)[keyof typeof ProviderType];

export interface Route {
  provider: Provider;
  providerType: ProviderTypeValue;
}

export class Router {
  constructor(private readonly providers: Map<ProviderTypeValue, Provider>) {}

  /**
   * Routing rules: an `openrouter/` prefix wins first; then `gpt-`, `o1-` and
   * `o3-` go to OpenAI and `claude-` to Anthropic; everything else (llama,
   * mistral, …) falls through to Local.
   */
  route(model: string): Route {
    const providerType = resolveProvider(model);
    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new ApiError(
        `provider '${providerType}' not configured for model '${model}'`,
        ErrorType.InvalidRequest,
      );
    }
    return { provider, providerType };
  }

  getProvider(providerType: ProviderTypeValue): Provider | undefined {
    return this.providers.get(providerType);
  }
}

export function resolveProvider(model: string): ProviderTypeValue {
  const lower = model.toLowerCase();
  if (lower.startsWith('openrouter/')) return ProviderType.OpenRouter;
  if (lower.startsWith('gpt-') || lower.startsWith('o1-') || lower.startsWith('o3-')) {
    return ProviderType.OpenAi;
  }
  if (lower.startsWith('claude-')) return ProviderType.Anthropic;
  return ProviderType.Local;
}
