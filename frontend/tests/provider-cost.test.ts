import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCompletion } from '../src/lib/api.ts';
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
