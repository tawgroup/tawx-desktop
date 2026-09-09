/**
 * Builds the provider set from configuration. Ported from the provider-wiring
 * half of gateway/gateway.go, minus the zrok/agora transports, which have no
 * TypeScript counterpart and are not used by the desktop config.
 */

import { AnthropicProvider } from './anthropic.js';
import { LocalProvider } from './local.js';
import { MultiLocalProvider } from './multiLocal.js';
import { OpenAiProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import { ProviderType, Router, type ProviderTypeValue } from './router.js';
import type { GatewayConfig } from '../config/config.js';
import type { Provider } from './provider.js';

export interface BuiltProviders {
  router: Router;
  /** Present only when local endpoints were configured as a pool. */
  multiLocal?: MultiLocalProvider;
}

export function buildProviders(config: GatewayConfig): BuiltProviders {
  const providers = new Map<ProviderTypeValue, Provider>();
  const configured = config.providers ?? {};
  let multiLocal: MultiLocalProvider | undefined;

  if (configured.open_ai?.api_key) {
    providers.set(
      ProviderType.OpenAi,
      new OpenAiProvider({ apiKey: configured.open_ai.api_key, baseUrl: configured.open_ai.base_url }),
    );
  }

  if (configured.open_router?.api_key) {
    providers.set(
      ProviderType.OpenRouter,
      new OpenRouterProvider({
        apiKey: configured.open_router.api_key,
        baseUrl: configured.open_router.base_url,
      }),
    );
  }

  if (configured.anthropic?.api_key) {
    providers.set(
      ProviderType.Anthropic,
      new AnthropicProvider({ apiKey: configured.anthropic.api_key, baseUrl: configured.anthropic.base_url }),
    );
  }

  const local = configured.local;
  if (local?.endpoints?.length) {
    multiLocal = new MultiLocalProvider(
      local.endpoints.map((endpoint) => ({
        name: endpoint.name ?? endpoint.base_url ?? 'local',
        baseUrl: endpoint.base_url ?? '',
        weight: endpoint.weight,
      })),
    );
    const health = local.health_check;
    if (health?.interval_seconds) {
      multiLocal.startHealthChecks(health.interval_seconds * 1000, (health.timeout_seconds ?? 5) * 1000);
    }
    providers.set(ProviderType.Local, multiLocal);
  } else if (local?.base_url) {
    providers.set(ProviderType.Local, new LocalProvider({ baseUrl: local.base_url }));
  }

  return { router: new Router(providers), multiLocal };
}
