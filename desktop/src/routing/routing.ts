/**
 * Semantic routing cascade. Ported from routing/routing.go.
 *
 * The embedding/semantic-similarity layer (routing/embeddings.go,
 * embedClient.go, vector.go) is deliberately not ported yet: the live desktop
 * config never sets routing.semantic.enabled, so that layer is off the live
 * path. SemanticMatcher below is the narrow seam
 * routing.go's cascade needs from it — createSemanticRouter never builds one
 * from an Embedder (that requires embeddings.go's centroid/cosine matching
 * over embedded exemplars), but a caller may inject an already-built
 * SemanticMatcher via its options for future wiring or tests.
 */

import { ClassifierMatcher } from './classifier.js';
import { HeuristicMatcher } from './heuristics.js';
import { allowExplicit } from './config.js';
import type { ClassifierMatcherOptions } from './classifier.js';
import type { RoutingConfig, RouteConfig } from './config.js';

/** Identifies how a routing decision was made. */
export const Method = {
  Explicit: 'explicit',
  Heuristic: 'heuristic',
  Semantic: 'semantic',
  Classifier: 'classifier',
  Default: 'default',
  Capability: 'capability',
} as const;
export type MethodValue = (typeof Method)[keyof typeof Method];

// wire contract mirror: github.com/netfoundry/sterling/internal/recipe carries
// the same constants and a matching golden-string test. changes must land in
// both repositories.
// capabilityVocabularyV1 is Sterling's gateway-owned route vocabulary. a
// capability class is resolved against the configured route name; the
// concrete model remains local gateway policy.
export const capabilityVocabularyV1 = 'sterling-classes/v1';

/** The sole class in Sterling's v1 vocabulary. */
export const capabilityFrontierCoding = 'frontier-coding';

/** Marks an OpenAI model ID as a Sterling capability alias rather than a concrete provider model. */
export const capabilityModelPrefix = 'sterling-capability:';

/** Describes the result of a routing decision. */
export interface Decision {
  route: string;
  model: string;
  method: MethodValue;
  confidence: number;
  latencyMs: number;
  cascade: string[];
}

/** A provider-independent representation of a chat request. */
export interface RequestInfo {
  model?: string;
  messages: MessageInfo[];
  maxTokens?: number;
  hasTools: boolean;
}

/** A simplified message for routing decisions. */
export interface MessageInfo {
  role: string;
  content: string;
}

/** Interface for generating text embeddings. Unused internally — see the module comment above. */
export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Narrow surface SemanticRouter needs from the embedding-similarity layer —
 * see the module comment above for why no implementation is wired up here.
 */
export interface SemanticMatcher {
  match(info: RequestInfo, signal?: AbortSignal): Promise<{ route: string; confidence: number }>;
}

/** Orchestrates the three-layer routing cascade. */
export class SemanticRouter {
  constructor(
    public readonly cfg: RoutingConfig,
    private readonly routeMap: Map<string, RouteConfig> = new Map(),
    private readonly heuristics?: HeuristicMatcher,
    private readonly semantic?: SemanticMatcher,
    private readonly classifier?: ClassifierMatcher,
  ) {}

  /** Performs the routing cascade and returns a decision. */
  async route(info: RequestInfo, signal?: AbortSignal): Promise<Decision> {
    const start = Date.now();
    const cascade: string[] = [];

    // explicit model passthrough
    if (info.model && allowExplicit(this.cfg)) {
      return {
        route: '',
        model: info.model,
        method: Method.Explicit,
        confidence: 1.0,
        latencyMs: Date.now() - start,
        cascade: [`explicit:${info.model}`],
      };
    }

    // layer 1: heuristics
    if (this.heuristics) {
      const route = this.heuristics.match(info);
      if (route !== '') {
        cascade.push(`heuristic:${route}`);
        const rc = this.routeMap.get(route);
        if (rc) {
          return {
            route,
            model: rc.model,
            method: Method.Heuristic,
            confidence: 1.0,
            latencyMs: Date.now() - start,
            cascade,
          };
        }
      } else {
        cascade.push('heuristic:no_match');
      }
    }

    // layer 2: embedding similarity
    if (this.semantic) {
      let matched: { route: string; confidence: number } | undefined;
      try {
        matched = await this.semantic.match(info, signal);
      } catch {
        cascade.push('semantic:error');
      }

      if (matched && matched.route !== '') {
        const { route, confidence } = matched;
        const threshold = this.cfg.semantic?.threshold ?? 0;
        const ambiguous = this.cfg.semantic?.ambiguousThreshold ?? 0;

        if (confidence >= threshold) {
          cascade.push(`semantic:${route}:${confidence.toFixed(2)}`);
          const rc = this.routeMap.get(route);
          if (rc) {
            return {
              route,
              model: rc.model,
              method: Method.Semantic,
              confidence,
              latencyMs: Date.now() - start,
              cascade,
            };
          }
        }

        // ambiguous: escalate to classifier if available
        if (confidence >= ambiguous && this.classifier) {
          cascade.push(`semantic:${route}:${confidence.toFixed(2)}:ambiguous`);
          let classified: { route: string; confidence: number } | undefined;
          try {
            classified = await this.classifier.classify(info, signal);
          } catch {
            cascade.push('classifier:error');
          }

          if (classified) {
            const confidenceThreshold = this.cfg.classifier?.confidenceThreshold ?? 0;
            if (classified.route !== '' && classified.confidence >= confidenceThreshold) {
              cascade.push(`classifier:${classified.route}:${classified.confidence.toFixed(2)}`);
              const rc = this.routeMap.get(classified.route);
              if (rc) {
                return {
                  route: classified.route,
                  model: rc.model,
                  method: Method.Classifier,
                  confidence: classified.confidence,
                  latencyMs: Date.now() - start,
                  cascade,
                };
              }
            } else if (classified.route !== '') {
              // record the candidate the classifier declined on, for tuning.
              cascade.push(`classifier:${classified.route}:${classified.confidence.toFixed(2)}:no_match`);
            } else {
              cascade.push('classifier:no_match');
            }
          }
        } else {
          // below the ambiguous window (or no classifier): keep the
          // candidate and score that caused the decline.
          cascade.push(`semantic:${route}:${confidence.toFixed(2)}:no_match`);
        }
      } else if (matched) {
        cascade.push('semantic:no_match');
      }
    } else if (this.classifier) {
      // no embeddings configured, try classifier directly
      let classified: { route: string; confidence: number } | undefined;
      try {
        classified = await this.classifier.classify(info, signal);
      } catch {
        cascade.push('classifier:error');
      }

      if (classified) {
        const confidenceThreshold = this.cfg.classifier?.confidenceThreshold ?? 0;
        if (classified.route !== '' && classified.confidence >= confidenceThreshold) {
          cascade.push(`classifier:${classified.route}:${classified.confidence.toFixed(2)}`);
          const rc = this.routeMap.get(classified.route);
          if (rc) {
            return {
              route: classified.route,
              model: rc.model,
              method: Method.Classifier,
              confidence: classified.confidence,
              latencyMs: Date.now() - start,
              cascade,
            };
          }
        } else if (classified.route !== '') {
          // record the candidate the classifier declined on, for tuning.
          cascade.push(`classifier:${classified.route}:${classified.confidence.toFixed(2)}:no_match`);
        } else {
          cascade.push('classifier:no_match');
        }
      }
    }

    // default route
    if (this.cfg.defaultRoute) {
      const rc = this.routeMap.get(this.cfg.defaultRoute);
      if (rc) {
        cascade.push(`default:${this.cfg.defaultRoute}`);
        return {
          route: this.cfg.defaultRoute,
          model: rc.model,
          method: Method.Default,
          confidence: 0,
          latencyMs: Date.now() - start,
          cascade,
        };
      }
    }

    // absolute fallback: use first route
    const first = this.cfg.routes[0];
    if (first) {
      cascade.push(`default:${first.name}`);
      return {
        route: first.name,
        model: first.model,
        method: Method.Default,
        confidence: 0,
        latencyMs: Date.now() - start,
        cascade,
      };
    }

    cascade.push('default');
    return {
      route: '',
      model: '',
      method: Method.Default,
      confidence: 0,
      latencyMs: Date.now() - start,
      cascade,
    };
  }

  /**
   * Resolves a signed Sterling capability coordinate without running the
   * request-routing cascade. Capability classes name gateway-owned routes, so
   * the result is deterministic for the gateway configuration at the time of
   * resolution.
   */
  resolveCapability(vocabulary: string, cls: string): Decision {
    if (vocabulary !== capabilityVocabularyV1) {
      throw new Error(`unsupported capability vocabulary '${vocabulary}'`);
    }
    if (cls !== capabilityFrontierCoding) {
      throw new Error(`unknown capability class '${cls}' in vocabulary '${vocabulary}'`);
    }
    const route = this.routeMap.get(cls);
    if (!route) {
      throw new Error(`unknown capability class '${cls}'`);
    }
    return {
      route: cls,
      model: route.model,
      method: Method.Capability,
      confidence: 1,
      latencyMs: 0,
      cascade: [`capability:${cls}`],
    };
  }

  /**
   * Parses and resolves a capability carried in the OpenAI model field. The
   * alias shape is sterling-capability:<vocabulary>/<class>. Sterling's
   * signed vocabulary grammar is exactly <segment>/v<N>, so the complete
   * alias has three slash-separated parts; changing that grammar requires
   * coordinated changes to Sterling's builder and this parser.
   */
  resolveCapabilityModel(model: string): Decision {
    if (!model.startsWith(capabilityModelPrefix)) {
      throw new Error(`model '${model}' is not a capability alias`);
    }
    const value = model.slice(capabilityModelPrefix.length);
    const parts = value.split('/');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new Error(`malformed capability model '${model}'`);
    }
    return this.resolveCapability(`${parts[0]}/${parts[1]}`, parts[2]);
  }
}

/** Reports whether model uses Sterling's capability-alias namespace. */
export function isCapabilityModel(model: string): boolean {
  return model.startsWith(capabilityModelPrefix);
}

/** Reports true if semantic routing is configured. */
export function isEnabled(sr: SemanticRouter | undefined): boolean {
  return sr !== undefined;
}

/** Reports the configured explicit-model policy. */
export function allowsExplicitModel(sr: SemanticRouter | undefined): boolean {
  return sr !== undefined && allowExplicit(sr.cfg);
}

/**
 * Checks the route set and its references at construction time and returns
 * the name -> route lookup. Each failure here is a misconfiguration that
 * would otherwise surface later as a silently dead rule, a phantom fallback,
 * or a matching layer that can never produce a decision.
 */
function validateRoutes(cfg: RoutingConfig): Map<string, RouteConfig> {
  const routeMap = new Map<string, RouteConfig>();
  cfg.routes.forEach((r, i) => {
    if (r.name === '') throw new Error(`route ${i} has an empty name`);
    if (r.model === '') throw new Error(`route ${i} ('${r.name}') has an empty model`);
    if (routeMap.has(r.name)) throw new Error(`route ${i} ('${r.name}') duplicates an earlier route name`);
    routeMap.set(r.name, r);
  });

  // a reference that does not resolve is a dead rule or a phantom fallback.
  if (cfg.defaultRoute) {
    if (!routeMap.has(cfg.defaultRoute)) {
      throw new Error(`default_route references unknown route '${cfg.defaultRoute}'`);
    }
  }
  if (cfg.heuristics?.enabled) {
    cfg.heuristics.rules.forEach((rule, i) => {
      if (!routeMap.has(rule.route)) {
        throw new Error(`heuristic rule ${i} references unknown route '${rule.route}'`);
      }
    });
  }

  // a routing block with no routes can never resolve a model — every layer
  // selects into the route set — yet a configured block still advertises the
  // 'auto' model and forces model-less requests through the cascade. refuse it,
  // keeping the directed message for the matcher-specific cases.
  if (cfg.routes.length === 0) {
    if (cfg.semantic?.enabled) {
      throw new Error('routing.semantic.enabled requires at least one route');
    } else if (cfg.classifier?.enabled) {
      throw new Error('routing.classifier.enabled requires at least one route');
    } else {
      throw new Error('routing requires at least one route');
    }
  }

  // an enabled classifier needs a model to call. unlike the embedding matcher
  // (which embeds at startup and so fails loud on a bad model) the classifier
  // is constructed lazily, so an empty model would otherwise surface only at
  // request time as a silent fall-through to the default route.
  if (cfg.classifier?.enabled && !cfg.classifier.model) {
    throw new Error('routing.classifier.model is required when routing.classifier.enabled is true');
  }

  return routeMap;
}

export interface CreateSemanticRouterOptions {
  /** Accepted for signature parity with Go's NewSemanticRouter; intentionally unused — see the module comment above. */
  embedder?: Embedder;
  /** Injects an already-built semantic matcher, since none is constructed automatically here. */
  semanticMatcher?: SemanticMatcher;
  classifierBaseUrl?: string;
  classifierApiKey?: string;
  classifierFetchImpl?: ClassifierMatcherOptions['fetchImpl'];
}

/**
 * Creates a SemanticRouter, validating the route set and wiring the
 * heuristic and classifier layers. Collapses Go's NewSemanticRouter and
 * NewSemanticRouterWithClassifier into one options bag.
 */
export function createSemanticRouter(
  cfg: RoutingConfig,
  options: CreateSemanticRouterOptions = {},
): SemanticRouter {
  const routeMap = validateRoutes(cfg);

  // layer 1: heuristics
  const heuristics = cfg.heuristics?.enabled ? new HeuristicMatcher(cfg.heuristics.rules) : undefined;

  // layer 2: embedding similarity — deliberately unwired, see the module
  // comment above. options.embedder is accepted only for signature parity.
  const semantic = cfg.semantic?.enabled ? options.semanticMatcher : undefined;

  // layer 3: llm classifier
  const classifier =
    cfg.classifier?.enabled && cfg.classifier
      ? new ClassifierMatcher(cfg.classifier, cfg.routes, {
          baseUrl: options.classifierBaseUrl ?? '',
          apiKey: options.classifierApiKey ?? '',
          fetchImpl: options.classifierFetchImpl,
        })
      : undefined;

  return new SemanticRouter(cfg, routeMap, heuristics, semantic, classifier);
}
