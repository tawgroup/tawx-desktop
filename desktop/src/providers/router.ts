/** Model-name to provider routing. Ported from providers/router.go. */

import { ApiError, ErrorType } from './errors.js';
import type { Provider } from './provider.js';

/**
 * The four providers that a config file can declare. Their values double as
 * the instance ids of config-file providers, so `openrouter/kimi-k2` selects
 * the same provider whether it arrives as a selector or by name sniffing.
 */
export const ProviderType = {
  OpenAi: 'openai',
  OpenRouter: 'openrouter',
  Anthropic: 'anthropic',
  Local: 'local',
} as const;

export type ProviderTypeValue = (typeof ProviderType)[keyof typeof ProviderType];

export interface ProviderInstance {
  id: string;
  provider: Provider;
}

export interface Route {
  provider: Provider;
  providerId: string;
  /** `model` with the `<providerId>/` selector removed, ready for the upstream. */
  model: string;
}

export class Router {
  private readonly byId: Map<string, Provider>;

  /**
   * Accepts the config-file map (keyed by ProviderType) or an explicit instance
   * list, which is what user-configured providers will supply.
   */
  constructor(providers: Map<ProviderTypeValue, Provider> | ProviderInstance[]) {
    this.byId = Array.isArray(providers)
      ? new Map(providers.map((instance) => [instance.id, instance.provider]))
      : new Map(providers);
  }

  /**
   * An explicit `<providerId>/<model>` selector wins; without one the legacy
   * name-prefix rules below decide. The selector is what lets two providers of
   * the same kind — two OpenAI-compatible endpoints, say — coexist, which name
   * sniffing alone cannot express.
   */
  route(model: string): Route {
    // First slash only: OpenRouter model ids carry slashes of their own, as in
    // openrouter/openai/gpt-4o-mini.
    const separator = model.indexOf('/');
    if (separator > 0) {
      const providerId = model.slice(0, separator);
      const provider = this.byId.get(providerId);
      if (provider) return { provider, providerId, model: model.slice(separator + 1) };
    }

    const providerId = resolveProvider(model);
    const provider = this.byId.get(providerId);
    if (!provider) {
      throw new ApiError(
        `provider '${providerId}' not configured for model '${model}'`,
        ErrorType.InvalidRequest,
      );
    }
    return { provider, providerId, model };
  }

  getProvider(providerId: string): Provider | undefined {
    return this.byId.get(providerId);
  }

  /**
   * Providers configured at runtime are added to this Router rather than to a
   * replacement: main.ts hands one instance to both the HTTP server and the
   * agent runtime, so a rebuilt Router would leave both holding the old set.
   */
  register(instance: ProviderInstance): void {
    this.byId.set(instance.id, instance.provider);
  }

  unregister(providerId: string): void {
    this.byId.delete(providerId);
  }

  has(providerId: string): boolean {
    return this.byId.has(providerId);
  }

  /** Every configured provider, for endpoints that aggregate across all of them. */
  instances(): ProviderInstance[] {
    return [...this.byId].map(([id, provider]) => ({ id, provider }));
  }
}

/**
 * Fallback for a bare model name. Routing rules: an `openrouter/` prefix wins
 * first; then `gpt-`, `o1-` and `o3-` go to OpenAI and `claude-` to Anthropic;
 * everything else (llama, mistral, …) falls through to Local.
 */
export function resolveProvider(model: string): ProviderTypeValue {
  const lower = model.toLowerCase();
  if (lower.startsWith('openrouter/')) return ProviderType.OpenRouter;
  if (lower.startsWith('gpt-') || lower.startsWith('o1-') || lower.startsWith('o3-')) {
    return ProviderType.OpenAi;
  }
  if (lower.startsWith('claude-')) return ProviderType.Anthropic;
  return ProviderType.Local;
}
