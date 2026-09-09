/**
 * Routing configuration. Ported from routing/config.go.
 *
 * config.go itself has no YAML tags — the parent gateway config (gateway/config.go)
 * decodes it via a generic snake_case mapper (dd.Merge) and then expands ${ENV_VAR}
 * references in routing.classifier.model and routing.routes[*].model once at load
 * (gateway/config.go's expandEnv). This module reproduces both: routingConfigFromYaml
 * converts the parsed `routing:` YAML node into a RoutingConfig, and expandRoutingEnv
 * applies the same env-expansion rule. etc/config.omp.yaml relies on both — see its
 * `routing.classifier.model: "${OMP_ROUTER_CLASSIFIER_MODEL}"` and route model fields.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** Top-level semantic routing configuration. */
export interface RoutingConfig {
  allowExplicitModel?: boolean;
  defaultRoute?: string;
  heuristics?: HeuristicsConfig;
  semantic?: SemanticConfig;
  classifier?: ClassifierConfig;
  routes: RouteConfig[];
}

/** Mirrors RoutingConfig.AllowExplicit(): defaults to true when unset. */
export function allowExplicit(cfg: RoutingConfig): boolean {
  return cfg.allowExplicitModel ?? true;
}

/** Configures heuristic-based routing rules. */
export interface HeuristicsConfig {
  enabled: boolean;
  rules: HeuristicRule[];
}

/** A single heuristic routing rule. */
export interface HeuristicRule {
  match: MatchCondition;
  route: string;
}

/**
 * Conditions for a heuristic rule. All present fields must match (AND logic) —
 * see heuristics.ts.
 */
export interface MatchCondition {
  keywords?: string[];
  /** Phrases that suppress a keyword match. */
  exclude?: string[];
  systemPromptContains?: string;
  maxTokensLt?: number;
  messageLengthLt?: number;
  hasTools?: boolean;
}

/**
 * Configures embedding-based semantic matching. The type is ported in full since
 * it is pure config data; the matcher that consumes it (routing/embeddings.go,
 * embedClient.go, vector.go) is deliberately not ported yet — see the
 * SemanticMatcher interface in routing.ts.
 */
export interface SemanticConfig {
  enabled: boolean;
  /** 'local' or 'openai' */
  provider?: string;
  model?: string;
  threshold: number;
  ambiguousThreshold: number;
  /** 'centroid', 'max', or 'average' */
  comparison?: string;
  cacheEmbeddings?: boolean;
  /** seconds, default 3600 */
  cacheTtl?: number;
  /** max entries, default 1000 */
  cacheSize?: number;
}

/** Configures LLM-based classification. */
export interface ClassifierConfig {
  enabled: boolean;
  /** 'local' or 'openai' */
  provider?: string;
  model: string;
  /** optional instruction prepended to the generated categories */
  prompt?: string;
  timeoutMs?: number;
  confidenceThreshold: number;
  cacheResults?: boolean;
  /** seconds, default 3600 */
  cacheTtl?: number;
  /** max entries, default 500 */
  cacheSize?: number;
}

/** A named route with a target model and exemplars. */
export interface RouteConfig {
  name: string;
  model: string;
  description?: string;
  examples?: string[];
}

/** Loads and parses the `routing:` block of a YAML config file, expanding env vars. */
export function loadRoutingConfig(path: string): RoutingConfig | undefined {
  const doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown> | undefined;
  const raw = doc?.routing;
  if (raw == null) return undefined;
  const cfg = routingConfigFromYaml(raw);
  expandRoutingEnv(cfg);
  return cfg;
}

/** Converts a parsed `routing:` YAML node into a RoutingConfig. Pure — no env expansion. */
export function routingConfigFromYaml(raw: unknown): RoutingConfig {
  const node = asRecord(raw);
  return {
    allowExplicitModel: asBoolean(node.allow_explicit_model),
    defaultRoute: asString(node.default_route),
    heuristics: node.heuristics != null ? heuristicsConfigFromYaml(node.heuristics) : undefined,
    semantic: node.semantic != null ? semanticConfigFromYaml(node.semantic) : undefined,
    classifier: node.classifier != null ? classifierConfigFromYaml(node.classifier) : undefined,
    routes: asArray(node.routes).map(routeConfigFromYaml),
  };
}

function heuristicsConfigFromYaml(raw: unknown): HeuristicsConfig {
  const node = asRecord(raw);
  return {
    enabled: asBoolean(node.enabled) ?? false,
    rules: asArray(node.rules).map(heuristicRuleFromYaml),
  };
}

function heuristicRuleFromYaml(raw: unknown): HeuristicRule {
  const node = asRecord(raw);
  return {
    match: matchConditionFromYaml(node.match),
    route: asString(node.route) ?? '',
  };
}

function matchConditionFromYaml(raw: unknown): MatchCondition {
  const node = asRecord(raw);
  return {
    keywords: asStringArray(node.keywords),
    exclude: asStringArray(node.exclude),
    systemPromptContains: asString(node.system_prompt_contains),
    maxTokensLt: asNumber(node.max_tokens_lt),
    messageLengthLt: asNumber(node.message_length_lt),
    hasTools: asBoolean(node.has_tools),
  };
}

function semanticConfigFromYaml(raw: unknown): SemanticConfig {
  const node = asRecord(raw);
  return {
    enabled: asBoolean(node.enabled) ?? false,
    provider: asString(node.provider),
    model: asString(node.model),
    threshold: asNumber(node.threshold) ?? 0,
    ambiguousThreshold: asNumber(node.ambiguous_threshold) ?? 0,
    comparison: asString(node.comparison),
    cacheEmbeddings: asBoolean(node.cache_embeddings),
    cacheTtl: asNumber(node.cache_ttl),
    cacheSize: asNumber(node.cache_size),
  };
}

function classifierConfigFromYaml(raw: unknown): ClassifierConfig {
  const node = asRecord(raw);
  return {
    enabled: asBoolean(node.enabled) ?? false,
    provider: asString(node.provider),
    model: asString(node.model) ?? '',
    prompt: asString(node.prompt),
    timeoutMs: asNumber(node.timeout_ms),
    confidenceThreshold: asNumber(node.confidence_threshold) ?? 0,
    cacheResults: asBoolean(node.cache_results),
    cacheTtl: asNumber(node.cache_ttl),
    cacheSize: asNumber(node.cache_size),
  };
}

function routeConfigFromYaml(raw: unknown): RouteConfig {
  const node = asRecord(raw);
  return {
    name: asString(node.name) ?? '',
    model: asString(node.model) ?? '',
    description: asString(node.description),
    examples: asStringArray(node.examples),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Resolves ${VAR} (and bare $VAR) references in routing.classifier.model and
 * routing.routes[*].model, mirroring gateway/config.go's expandEnv for the
 * Routing section. A field that is set but expands to an empty string is a
 * misconfiguration (an unset environment variable silently blanking out a
 * model), so it is rejected rather than passed through empty.
 */
export function expandRoutingEnv(cfg: RoutingConfig): void {
  const expand = (field: string, value: string): string => {
    if (value === '') return value;
    const expanded = expandEnvVars(value);
    if (expanded === '') {
      throw new Error(`${field} resolves empty (unset environment variable?)`);
    }
    return expanded;
  };

  if (cfg.classifier) {
    cfg.classifier.model = expand('routing.classifier.model', cfg.classifier.model);
  }
  cfg.routes.forEach((route, i) => {
    route.model = expand(`routing.routes[${i}].model`, route.model);
  });
}

/** Replicates Go's os.ExpandEnv: ${name} and bare $name, undefined vars become ''. */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, bare) => {
    const name = (braced ?? bare) as string;
    return process.env[name] ?? '';
  });
}
