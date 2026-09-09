/** Ported from routing/routing_test.go. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SemanticRouter,
  Method,
  capabilityVocabularyV1,
  capabilityFrontierCoding,
  capabilityModelPrefix,
  createSemanticRouter,
  isEnabled,
} from './routing.js';
import type { RoutingConfig } from './config.js';
import type { RequestInfo, SemanticMatcher } from './routing.js';

function throwsWithMessage(fn: () => unknown, substring: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes(substring), `error ${JSON.stringify(err.message)} does not include ${JSON.stringify(substring)}`);
    return true;
  });
}

test('semantic router explicit model', () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    routes: [{ name: 'general', model: 'llama3' }],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hello' }],
    hasTools: false,
  };

  return sr.route(info).then((decision) => {
    assert.equal(decision.method, Method.Explicit);
    assert.equal(decision.model, 'gpt-4');
  });
});

test('semantic router explicit model disallowed', async () => {
  const cfg: RoutingConfig = {
    allowExplicitModel: false,
    defaultRoute: 'general',
    routes: [{ name: 'general', model: 'llama3' }],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hello' }],
    hasTools: false,
  };

  const decision = await sr.route(info);
  // should not use explicit method since it's disallowed
  assert.notEqual(decision.method, Method.Explicit);
});

test('semantic router rejects unknown route refs', () => {
  // a default_route that resolves to no route is a phantom fallback.
  let cfg: RoutingConfig = {
    defaultRoute: 'genral',
    routes: [{ name: 'general', model: 'gpt-4' }],
  };
  throwsWithMessage(() => createSemanticRouter(cfg), "default_route references unknown route 'genral'");

  // a matching layer enabled with no routes can never decide.
  cfg = { routes: [], classifier: { enabled: true, model: '', confidenceThreshold: 0 } };
  throwsWithMessage(() => createSemanticRouter(cfg), 'routing.classifier.enabled requires at least one route');

  cfg = { routes: [], semantic: { enabled: true, threshold: 0, ambiguousThreshold: 0 } };
  throwsWithMessage(() => createSemanticRouter(cfg), 'routing.semantic.enabled requires at least one route');

  // a configured routing block with no routes at all can never resolve a
  // model, yet would advertise 'auto'; refuse it even with no matcher enabled.
  cfg = { allowExplicitModel: false, routes: [] };
  throwsWithMessage(() => createSemanticRouter(cfg), 'routing requires at least one route');

  // an enabled classifier with no model can never call its backend; it is
  // constructed lazily, so the gap would otherwise surface only at request time.
  cfg = {
    routes: [{ name: 'coding', model: 'llama3' }],
    classifier: { enabled: true, model: '', confidenceThreshold: 0 },
  };
  throwsWithMessage(() => createSemanticRouter(cfg), 'routing.classifier.model is required');

  // an unnamed route is unaddressable and unauthorizable.
  cfg = { routes: [{ name: '', model: 'llama3' }] };
  throwsWithMessage(() => createSemanticRouter(cfg), 'route 0 has an empty name');

  // a route with an empty model cannot be dispatched; refuse it at
  // construction so a selected route always yields a model.
  cfg = { routes: [{ name: 'coding', model: '' }] };
  throwsWithMessage(() => createSemanticRouter(cfg), "route 0 ('coding') has an empty model");

  // a heuristic rule targeting a nonexistent route is permanently dead.
  cfg = {
    heuristics: {
      enabled: true,
      rules: [{ match: { keywords: ['translate'] }, route: 'codng' }],
    },
    routes: [{ name: 'coding', model: 'llama3' }],
  };
  throwsWithMessage(() => createSemanticRouter(cfg), "heuristic rule 0 references unknown route 'codng'");
});

test('semantic router heuristic', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    heuristics: {
      enabled: true,
      rules: [{ match: { keywords: ['translate'] }, route: 'fast' }],
    },
    routes: [
      { name: 'fast', model: 'llama3' },
      { name: 'general', model: 'gpt-4' },
    ],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = {
    messages: [{ role: 'user', content: 'translate this to French' }],
    hasTools: false,
  };

  const decision = await sr.route(info);
  assert.equal(decision.method, Method.Heuristic);
  assert.equal(decision.model, 'llama3');
});

test('resolve capability', async () => {
  const golden = 'sterling-capability:sterling-classes/v1/frontier-coding';
  assert.equal(
    capabilityModelPrefix + capabilityVocabularyV1 + '/' + capabilityFrontierCoding,
    golden,
    "capability wire alias mismatch; update Sterling's mirrored contract with any change",
  );

  const cfg: RoutingConfig = {
    routes: [
      { name: 'frontier-coding', model: 'claude-opus-4-x' },
      { name: 'general-chat', model: 'gpt-4.1' },
    ],
  };
  const sr = createSemanticRouter(cfg);

  const decision = sr.resolveCapability(capabilityVocabularyV1, 'frontier-coding');
  assert.equal(decision.model, 'claude-opus-4-x');
  assert.equal(decision.route, 'frontier-coding');

  for (const [vocabulary, cls] of [
    ['sterling-classes/v2', 'frontier-coding'],
    [capabilityVocabularyV1, 'general-chat'],
  ]) {
    assert.throws(() => sr.resolveCapability(vocabulary as string, cls as string));
  }

  const decision2 = sr.resolveCapabilityModel(golden);
  assert.equal(decision2.model, 'claude-opus-4-x');

  for (const model of [
    capabilityModelPrefix,
    capabilityModelPrefix + 'sterling-classes/v1',
    capabilityModelPrefix + 'sterling-classes/v1/frontier-coding/extra',
  ]) {
    assert.throws(() => sr.resolveCapabilityModel(model));
  }
});

/**
 * Hand-derived from the mockEmbedder vectors in embeddings_test.go /
 * routing_test.go, since the centroid/cosine implementation itself
 * (embeddings.go, vector.go) is deliberately not ported — see routing.ts's
 * module comment. coding's centroid over {1,0} and {0.9,0.1} is {0.95,0.05},
 * which is exactly the "debug my code" query vector, so cosine similarity is
 * 1.0; creative's centroid {0.05,0.95} is nowhere close.
 */
function semanticFakeForRouterSemanticTest(): SemanticMatcher {
  return {
    async match(info) {
      const last = info.messages[info.messages.length - 1];
      if (last?.content === 'debug my code') return { route: 'coding', confidence: 1.0 };
      return { route: '', confidence: 0 };
    },
  };
}

test('semantic router semantic', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    semantic: { enabled: true, threshold: 0.8, ambiguousThreshold: 0.5, comparison: 'centroid' },
    routes: [
      { name: 'coding', model: 'gpt-4', examples: ['write code', 'fix bugs'] },
      { name: 'creative', model: 'claude-3', examples: ['write a poem', 'tell a story'] },
      { name: 'general', model: 'llama3' },
    ],
  };

  const sr = createSemanticRouter(cfg, { semanticMatcher: semanticFakeForRouterSemanticTest() });

  const info: RequestInfo = { messages: [{ role: 'user', content: 'debug my code' }], hasTools: false };

  const decision = await sr.route(info);
  assert.equal(decision.method, Method.Semantic);
  assert.equal(decision.route, 'coding');
});

test('semantic router default', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    routes: [{ name: 'general', model: 'llama3' }],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = { messages: [{ role: 'user', content: 'hello' }], hasTools: false };

  const decision = await sr.route(info);
  assert.equal(decision.method, Method.Default);
  assert.equal(decision.model, 'llama3');
});

/**
 * Hand-derived like the fake above: "example" embeds to {1,0} (route
 * "specific"'s only exemplar, so its centroid is also {1,0}); "test input"
 * embeds to {0.5,0.5}. cosine({0.5,0.5},{1,0}) = 0.5 / (sqrt(0.5)*1) =
 * 1/sqrt(2) ≈ 0.7071 — below the 0.95 threshold this test configures.
 */
function semanticFakeForCascadeOrderTest(): SemanticMatcher {
  return {
    async match(info) {
      const last = info.messages[info.messages.length - 1];
      if (last?.content === 'test input') return { route: 'specific', confidence: 1 / Math.sqrt(2) };
      return { route: '', confidence: 0 };
    },
  };
}

test('semantic router cascade order', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    heuristics: { enabled: true, rules: [] }, // no rules that match
    semantic: { enabled: true, threshold: 0.95, ambiguousThreshold: 0.3, comparison: 'centroid' }, // high threshold, embedding won't meet it
    routes: [
      { name: 'specific', model: 'gpt-4', examples: ['example'] },
      { name: 'general', model: 'llama3' },
    ],
  };

  const sr = createSemanticRouter(cfg, { semanticMatcher: semanticFakeForCascadeOrderTest() });

  const info: RequestInfo = { messages: [{ role: 'user', content: 'test input' }], hasTools: false };

  const decision = await sr.route(info);

  // should fall through all layers to default
  assert.equal(decision.method, Method.Default);

  // cascade should show all attempted layers with detail
  assert.ok(decision.cascade.length >= 3, `expected at least 3 cascade entries, got ${JSON.stringify(decision.cascade)}`);
  assert.equal(decision.cascade[0], 'heuristic:no_match');
  // semantic entry should start with "semantic:"
  assert.ok(decision.cascade[1]?.startsWith('semantic:'));
  // last entry should start with "default:"
  assert.ok(decision.cascade[decision.cascade.length - 1]?.startsWith('default:'));
});

test('semantic router heuristic cascade format', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    heuristics: {
      enabled: true,
      rules: [{ match: { keywords: ['translate'] }, route: 'fast' }],
    },
    routes: [
      { name: 'fast', model: 'llama3' },
      { name: 'general', model: 'gpt-4' },
    ],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = { messages: [{ role: 'user', content: 'translate this to French' }], hasTools: false };

  const decision = await sr.route(info);
  assert.deepEqual(decision.cascade, ['heuristic:fast']);
});

test('semantic router explicit cascade format', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    routes: [{ name: 'general', model: 'llama3' }],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }], hasTools: false };

  const decision = await sr.route(info);
  assert.deepEqual(decision.cascade, ['explicit:gpt-4']);
});

test('semantic router default cascade format', async () => {
  const cfg: RoutingConfig = {
    defaultRoute: 'general',
    routes: [{ name: 'general', model: 'llama3' }],
  };

  const sr = createSemanticRouter(cfg);

  const info: RequestInfo = { messages: [{ role: 'user', content: 'hello' }], hasTools: false };

  const decision = await sr.route(info);
  assert.deepEqual(decision.cascade, ['default:general']);
});

test('semantic router enabled', () => {
  const sr = new SemanticRouter({ routes: [] } as RoutingConfig);
  assert.equal(isEnabled(sr), true);
  assert.equal(isEnabled(undefined), false);
});
