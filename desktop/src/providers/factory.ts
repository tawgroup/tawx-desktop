/**
 * Builds the provider set from configuration. Ported from the provider-wiring
 * half of gateway/gateway.go, minus the zrok/agora transports, which have no
 * TypeScript counterpart and are not used by the desktop config.
 *
 * Each config section names a kind; construction itself lives in kinds.ts, so
 * a new vendor never needs a branch here.
 */

import { createProvider, ProviderKind, type ProviderKindValue } from './kinds.js';
import { MultiLocalProvider } from './multiLocal.js';
import { ProviderType, Router, type ProviderTypeValue } from './router.js';
import type { GatewayConfig } from '../config/config.js';
import type { Provider } from './provider.js';

export interface BuiltProviders {
  router: Router;
  /** Present only when local endpoints were configured as a pool. */
  multiLocal?: MultiLocalProvider;
}

/**
 * The keyed provider sections of the config, in the order they are offered to
 * /v1/models. Each is built only when it carries an API key.
 */
const KEYED_SECTIONS: Array<{
  id: ProviderTypeValue;
  kind: ProviderKindValue;
  section: 'open_ai' | 'open_router' | 'anthropic';
}> = [
  { id: ProviderType.OpenAi, kind: ProviderKind.OpenAiCompatible, section: 'open_ai' },
  { id: ProviderType.OpenRouter, kind: ProviderKind.OpenRouter, section: 'open_router' },
  { id: ProviderType.Anthropic, kind: ProviderKind.Anthropic, section: 'anthropic' },
];

export function buildProviders(config: GatewayConfig): BuiltProviders {
  const providers = new Map<ProviderTypeValue, Provider>();
  const configured = config.providers ?? {};
  let multiLocal: MultiLocalProvider | undefined;

  for (const { id, kind, section } of KEYED_SECTIONS) {
    const settings = configured[section];
    if (!settings?.api_key) continue;
    providers.set(id, createProvider(kind, { apiKey: settings.api_key, baseUrl: settings.base_url }));
  }

  // The local pool has no counterpart in kinds.ts: MultiLocalProvider fans out
  // across several endpoints with health checks rather than adapting one
  // vendor's wire format, so it is wired by hand.
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
    providers.set(ProviderType.Local, createProvider(ProviderKind.Ollama, { baseUrl: local.base_url }));
  }

  return { router: new Router(providers), multiLocal };
}
