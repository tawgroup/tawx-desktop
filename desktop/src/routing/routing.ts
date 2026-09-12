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

import { Cause, Data, Effect } from 'effect';
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

/**
 * Typed failure of one cascade layer (`semantic` or `classifier`). Layer
 * errors never reject `route` — they are recovered into `cascade` entries
 * (`<layer>:error`) via `recoverLayer` — but they travel typed through the
 * Effect chain instead of being swallowed by an empty `catch {}`, with the
 * original error kept on `cause`.
 */
export class SemanticLayerError extends Data.TaggedError('SemanticLayerError')<{
  readonly layer: 'semantic' | 'classifier';
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Typed configuration failure for `validateRoutesEffect` (message-compatible with the `Error` it replaces). */
export class RoutingConfigError extends Data.TaggedError('RoutingConfigError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Typed capability-resolution failure (message-compatible with the `Error` it replaces). */
export class CapabilityError extends Data.TaggedError('CapabilityError')<{
  readonly message: string;
}> {}

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

  /**
   * Effect core of the routing cascade: heuristics → semantic → classifier →
   * default. Infallible by design (`Effect<Decision, never>`) — layer failures
   * are typed `SemanticLayerError`s recovered into `cascade` entries, never
   * thrown, so every decision still carries the full audit trail.
   */
  routeEffect(info: RequestInfo, signal?: AbortSignal): Effect.Effect<Decision, never> {
    const self = this;
    return Effect.gen(function* () {
      const start = Date.now();
      const cascade: string[] = [];

      // explicit model passthrough
      if (info.model && allowExplicit(self.cfg)) {
        return {
          route: '',
          model: info.model,
          method: Method.Explicit,
          confidence: 1.0,
          latencyMs: Date.now() - start,
          cascade: [`explicit:${info.model}`],
        };
      }

      // layer 1: heuristics — a pure match lifted into the Effect chain so the
      // whole cascade composes. A hit on an unknown route is impossible
      // (validateRoutes rejects it at construction), so it records no_match.
      const heuristics = self.heuristics;
      if (heuristics) {
        const route = yield* Effect.sync(() => heuristics.match(info));
        if (route !== '') {
          cascade.push(`heuristic:${route}`);
          const rc = self.routeMap.get(route);
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

      // layer 2: embedding similarity, with typed-error recovery into cascade
      const semantic = self.semantic;
      const classifier = self.classifier;
      if (semantic) {
        const matched = yield* self.recoverLayer(
          self.matchSemanticEffect(semantic, info, signal),
          cascade,
        );

        if (matched && matched.route !== '') {
          const { route, confidence } = matched;
          const threshold = self.cfg.semantic?.threshold ?? 0;
          const ambiguous = self.cfg.semantic?.ambiguousThreshold ?? 0;

          if (confidence >= threshold) {
            cascade.push(`semantic:${route}:${confidence.toFixed(2)}`);
            const rc = self.routeMap.get(route);
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
          if (confidence >= ambiguous && classifier) {
            cascade.push(`semantic:${route}:${confidence.toFixed(2)}:ambiguous`);
            const classified = yield* self.recoverLayer(
              self.classifyLayerEffect(classifier, info, signal),
              cascade,
            );
            const decision = self.applyClassifierResult(classified, cascade, start);
            if (decision) return decision;
          } else {
            // below the ambiguous window (or no classifier): keep the
            // candidate and score that caused the decline.
            cascade.push(`semantic:${route}:${confidence.toFixed(2)}:no_match`);
          }
        } else if (matched) {
          cascade.push('semantic:no_match');
        }
      } else if (classifier) {
        // no embeddings configured, try classifier directly
        const classified = yield* self.recoverLayer(
          self.classifyLayerEffect(classifier, info, signal),
          cascade,
        );
        const decision = self.applyClassifierResult(classified, cascade, start);
        if (decision) return decision;
      }

      // default route
      if (self.cfg.defaultRoute) {
        const rc = self.routeMap.get(self.cfg.defaultRoute);
        if (rc) {
          cascade.push(`default:${self.cfg.defaultRoute}`);
          return {
            route: self.cfg.defaultRoute,
            model: rc.model,
            method: Method.Default,
            confidence: 0,
            latencyMs: Date.now() - start,
            cascade,
          };
        }
      }

      // absolute fallback: use first route
      const first = self.cfg.routes[0];
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
    });
  }

  /**
   * Promise compatibility boundary: same signature as before — main.ts awaits
   * this. Layer errors are already recovered into `cascade` inside
   * `routeEffect`, so this only ever rejects on unexpected defects, surfaced
   * raw (no `FiberFailure` wrapper).
   */
  async route(info: RequestInfo, signal?: AbortSignal): Promise<Decision> {
    const exit = await Effect.runPromiseExit(this.routeEffect(info, signal));
    if (exit._tag === 'Failure') throw Cause.squash(exit.cause);
    return exit.value;
  }

  /**
   * Recovers a layer attempt into the cascade log. The typed error writes its
   * `<layer>:error` entry via `tapError` (auditable, never silently dropped)
   * and `orElse` continues the cascade with `undefined` — the Effect spelling
   * of the old `try/catch → push → fall through`, minus the empty `catch {}`.
   */
  private recoverLayer<T>(
    attempt: Effect.Effect<T, SemanticLayerError>,
    cascade: string[],
  ): Effect.Effect<T | undefined, never> {
    return attempt.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          cascade.push(`${error.layer}:error`);
        }),
      ),
      Effect.orElse(() => Effect.succeed(undefined)),
    );
  }

  /** Runs the embedding-similarity matcher; rejections become typed layer errors. */
  private matchSemanticEffect(
    matcher: SemanticMatcher,
    info: RequestInfo,
    signal: AbortSignal | undefined,
  ): Effect.Effect<{ route: string; confidence: number }, SemanticLayerError> {
    return Effect.tryPromise({
      try: () => matcher.match(info, signal),
      catch: (cause) =>
        new SemanticLayerError({
          layer: 'semantic',
          message: `semantic layer failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
  }

  /** Runs the LLM classifier; its typed `ClassifierError` is adapted to the cascade's layer error. */
  private classifyLayerEffect(
    matcher: ClassifierMatcher,
    info: RequestInfo,
    signal: AbortSignal | undefined,
  ): Effect.Effect<{ route: string; confidence: number }, SemanticLayerError> {
    return matcher.classifyEffect(info, signal).pipe(
      Effect.mapError(
        (cause): SemanticLayerError =>
          new SemanticLayerError({ layer: 'classifier', message: cause.message, cause }),
      ),
    );
  }

  /**
   * Applies a (possibly recovered-absent) classifier result: accepts it when
   * it clears the confidence threshold, otherwise records the declined
   * candidate for tuning. Returns a decision on accept, `undefined` to fall
   * through to the default route.
   */
  private applyClassifierResult(
    classified: { route: string; confidence: number } | undefined,
    cascade: string[],
    start: number,
  ): Decision | undefined {
    if (!classified) return undefined;
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
      return undefined;
    }
    if (classified.route !== '') {
      // record the candidate the classifier declined on, for tuning.
      cascade.push(`classifier:${classified.route}:${classified.confidence.toFixed(2)}:no_match`);
    } else {
      cascade.push('classifier:no_match');
    }
    return undefined;
  }

  /**
   * Effect core of capability resolution: fails with a typed
   * `CapabilityError` instead of throwing.
   */
  resolveCapabilityEffect(vocabulary: string, cls: string): Effect.Effect<Decision, CapabilityError> {
    if (vocabulary !== capabilityVocabularyV1) {
      return Effect.fail(
        new CapabilityError({ message: `unsupported capability vocabulary '${vocabulary}'` }),
      );
    }
    if (cls !== capabilityFrontierCoding) {
      return Effect.fail(
        new CapabilityError({
          message: `unknown capability class '${cls}' in vocabulary '${vocabulary}'`,
        }),
      );
    }
    const route = this.routeMap.get(cls);
    if (!route) {
      return Effect.fail(new CapabilityError({ message: `unknown capability class '${cls}'` }));
    }
    return Effect.succeed({
      route: cls,
      model: route.model,
      method: Method.Capability,
      confidence: 1,
      latencyMs: 0,
      cascade: [`capability:${cls}`],
    });
  }

  /**
   * Resolves a signed Sterling capability coordinate without running the
   * request-routing cascade. Capability classes name gateway-owned routes, so
   * the result is deterministic for the gateway configuration at the time of
   * resolution.
   *
   * Sync compatibility boundary: same signature and `Error` throw as before.
   */
  resolveCapability(vocabulary: string, cls: string): Decision {
    const exit = Effect.runSyncExit(
      this.resolveCapabilityEffect(vocabulary, cls).pipe(
        Effect.mapError((error) => new Error(error.message)),
      ),
    );
    if (exit._tag === 'Failure') throw Cause.squash(exit.cause);
    return exit.value;
  }

  /**
   * Effect core of capability-alias parsing: malformed aliases fail typed,
   * then resolution delegates to `resolveCapabilityEffect`.
   */
  resolveCapabilityModelEffect(model: string): Effect.Effect<Decision, CapabilityError> {
    if (!model.startsWith(capabilityModelPrefix)) {
      return Effect.fail(
        new CapabilityError({ message: `model '${model}' is not a capability alias` }),
      );
    }
    const value = model.slice(capabilityModelPrefix.length);
    const parts = value.split('/');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      return Effect.fail(
        new CapabilityError({ message: `malformed capability model '${model}'` }),
      );
    }
    return this.resolveCapabilityEffect(`${parts[0]}/${parts[1]}`, parts[2]);
  }

  /**
   * Parses and resolves a capability carried in the OpenAI model field. The
   * alias shape is sterling-capability:<vocabulary>/<class>. Sterling's
   * signed vocabulary grammar is exactly <segment>/v<N>, so the complete
   * alias has three slash-separated parts; changing that grammar requires
   * coordinated changes to Sterling's builder and this parser.
   *
   * Sync compatibility boundary: same signature and `Error` throw as before.
   */
  resolveCapabilityModel(model: string): Decision {
    const exit = Effect.runSyncExit(
      this.resolveCapabilityModelEffect(model).pipe(
        Effect.mapError((error) => new Error(error.message)),
      ),
    );
    if (exit._tag === 'Failure') throw Cause.squash(exit.cause);
    return exit.value;
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
 * Effect core of route-set validation: each misconfiguration fails with a
 * typed `RoutingConfigError` (message-identical to the `Error` it replaces),
 * so construction-time failures are matchable instead of opaque throws.
 */
function validateRoutesEffect(cfg: RoutingConfig): Effect.Effect<Map<string, RouteConfig>, RoutingConfigError> {
  return Effect.try({
    try: () => validateRoutes(cfg),
    catch: (cause) =>
      new RoutingConfigError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
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
 *
 * Validation runs through `validateRoutesEffect`; the typed failure is mapped
 * back to a plain `Error` at this boundary, so misconfiguration still throws
 * with the exact same messages as before.
 */
export function createSemanticRouter(
  cfg: RoutingConfig,
  options: CreateSemanticRouterOptions = {},
): SemanticRouter {
  const exit = Effect.runSyncExit(
    validateRoutesEffect(cfg).pipe(Effect.mapError((error) => new Error(error.message))),
  );
  if (exit._tag === 'Failure') throw Cause.squash(exit.cause);
  const routeMap = exit.value;

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
