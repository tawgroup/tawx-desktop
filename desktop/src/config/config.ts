/**
 * Gateway configuration. Ported from the gateway-owned half of
 * gateway/config.go — the `routing:` block is handed to the routing package
 * untouched, and the zrok/agora/api_keys subsystems are deliberately absent
 * (they are Go-only overlay networking and are not part of the desktop app).
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { expandRoutingEnv, routingConfigFromYaml, type RoutingConfig } from '../routing/config.js';

export interface OpenAiConfig {
  api_key?: string;
  base_url?: string;
}

export interface LocalEndpointConfig {
  name?: string;
  base_url?: string;
  weight?: number;
}

export interface HealthCheckConfig {
  interval_seconds?: number;
  timeout_seconds?: number;
}

export interface LocalConfig {
  base_url?: string;
  endpoints?: LocalEndpointConfig[];
  health_check?: HealthCheckConfig;
}

export interface ProvidersConfig {
  open_ai?: OpenAiConfig;
  open_router?: OpenAiConfig;
  anthropic?: OpenAiConfig;
  local?: LocalConfig;
}

export interface MetricsConfig {
  enabled?: boolean;
}

export interface GatewayConfig {
  listen: string;
  providers?: ProvidersConfig;
  routing?: RoutingConfig;
  metrics?: MetricsConfig;
}

export const DEFAULT_LISTEN = '127.0.0.1:18080';

export async function loadConfig(path: string): Promise<GatewayConfig> {
  const raw = (parseYaml(await readFile(path, 'utf8')) ?? {}) as Record<string, unknown>;
  const config: GatewayConfig = { listen: DEFAULT_LISTEN, ...(raw as Partial<GatewayConfig>) };

  // the routing block has its own binder and its own ${VAR} rules; hand it over
  // rather than letting the loose spread above leave raw YAML in place
  if (raw.routing) {
    config.routing = routingConfigFromYaml(raw.routing);
    expandRoutingEnv(config.routing);
  }

  expandConfigEnv(config);
  normalize(config);
  validateProviders(config);
  return config;
}

/**
 * Resolves ${VAR} references in gateway-owned provider fields once at load.
 * An unset variable is an error rather than an empty string: a base URL or API
 * key that silently resolves to "" fails much later and much less legibly.
 */
export function expandConfigEnv(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): void {
  const expandField = <T extends object>(field: string, holder: T, key: keyof T & string): void => {
    const value = (holder as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value === '') return;

    const expanded = expandEnv(value, env);
    if (expanded === '') throw new Error(`${field} resolves empty (unset environment variable?)`);
    (holder as Record<string, unknown>)[key] = expanded;
  };

  const providers = config.providers;
  if (!providers) return;

  for (const name of ['open_ai', 'open_router', 'anthropic'] as const) {
    const provider = providers[name];
    if (!provider) continue;
    expandField(`providers.${name}.api_key`, provider, 'api_key');
    expandField(`providers.${name}.base_url`, provider, 'base_url');
  }

  const local = providers.local;
  if (local) {
    expandField('providers.local.base_url', local, 'base_url');
    local.endpoints?.forEach((endpoint, index) =>
      expandField(`providers.local.endpoints[${index}].base_url`, endpoint, 'base_url'),
    );
  }
}

/** Mirrors Go's os.ExpandEnv: both $VAR and ${VAR}, unset expanding to ''. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, bare) =>
    env[(braced ?? bare) as string] ?? '',
  );
}

function normalize(config: GatewayConfig): void {
  if (!config.listen) config.listen = DEFAULT_LISTEN;

  const local = config.providers?.local;
  if (local?.endpoints?.length) {
    for (const endpoint of local.endpoints) {
      if (!endpoint.weight || endpoint.weight <= 0) endpoint.weight = 1;
      if (!endpoint.name) endpoint.name = endpoint.base_url ?? 'local';
    }
  }
}

function validateProviders(config: GatewayConfig): void {
  const providers = config.providers;
  if (!providers || Object.keys(providers).length === 0) {
    throw new Error('providers: at least one provider must be configured');
  }

  const local = providers.local;
  if (local && !local.base_url && !local.endpoints?.length) {
    throw new Error('providers.local: either base_url or endpoints must be set');
  }
  for (const [index, endpoint] of (local?.endpoints ?? []).entries()) {
    if (!endpoint.base_url) throw new Error(`providers.local.endpoints[${index}]: base_url is required`);
  }
}
