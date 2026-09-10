import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCompletion } from '../src/lib/api.ts';
import { estimateUsageCost } from '../src/lib/pricing.ts';
import { normalizeProvider } from '../src/lib/providers.ts';

const deepSeek = normalizeProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'test-key',
  model: 'deepseek-flash',
});

test('a direct DeepSeek response derives cost from detailed token usage', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'deepseek-flash',
    choices: [{ message: { content: 'ok' } }],
    usage: {
      prompt_tokens: 9,
      completion_tokens: 3,
      total_tokens: 12,
      prompt_cache_hit_tokens: 4,
      prompt_cache_miss_tokens: 5,
      prompt_tokens_details: { cached_tokens: 4 },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await fetchCompletion({
      provider: deepSeek,
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(result.usage?.inputTokens, 9);
    assert.equal(result.usage?.outputTokens, 3);
    assert.equal(typeof result.usage?.cost, 'number');
    assert.ok((result.usage?.cost ?? 0) > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a provider-reported cost remains authoritative', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'deepseek-flash',
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12, cost: 0.123 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await fetchCompletion({
      provider: deepSeek,
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.usage?.cost, 0.123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DeepSeek estimates cache hits, misses, output, peak hours and the V4 Pro retirement', () => {
  const usage = {
    prompt_tokens: 9,
    completion_tokens: 3,
    prompt_cache_hit_tokens: 4,
    prompt_cache_miss_tokens: 5,
  };
  const offPeak = estimateUsageCost(deepSeek, 'deepseek-flash', usage, new Date('2026-09-10T14:00:00Z'));
  const peak = estimateUsageCost(deepSeek, 'deepseek-flash', usage, new Date('2026-09-10T02:00:00Z'));
  const retiredPro = estimateUsageCost(deepSeek, 'deepseek-v4-pro', usage, new Date('2026-09-15T14:00:00Z'));

  assert.ok(Math.abs((offPeak ?? 0) - 0.000002562) < 1e-15);
  assert.ok(Math.abs((peak ?? 0) - 0.000005124) < 1e-15);
  assert.equal(retiredPro, offPeak);
});

test('local inference is zero-cost and unknown remote pricing stays unknown', () => {
  const usage = { prompt_tokens: 9, completion_tokens: 3 };
  const local = normalizeProvider({
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'llama3.2',
  });
  const unknown = normalizeProvider({
    id: 'custom',
    name: 'Custom',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'custom-model',
  });

  assert.equal(estimateUsageCost(local, local.model, usage), 0);
  assert.equal(estimateUsageCost(unknown, unknown.model, usage), undefined);
});
