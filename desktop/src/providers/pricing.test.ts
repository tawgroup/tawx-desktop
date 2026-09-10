import assert from 'node:assert/strict';
import test from 'node:test';
import { withEstimatedUsageCost } from './pricing.js';
import type { Usage } from './types.js';

const usage: Usage = {
  prompt_tokens: 9,
  completion_tokens: 3,
  total_tokens: 12,
  prompt_cache_hit_tokens: 4,
  prompt_cache_miss_tokens: 5,
};

test('DeepSeek gateway responses gain a cache-aware off-peak cost', () => {
  const result = withEstimatedUsageCost(
    'https://api.deepseek.com',
    'deepseek-flash',
    usage,
    new Date('2026-09-10T14:00:00Z'),
  );
  assert.ok(Math.abs((result?.cost ?? 0) - 0.000002562) < 1e-15);
});

test('provider cost is authoritative and unknown providers are unchanged', () => {
  assert.equal(withEstimatedUsageCost(
    'https://api.deepseek.com',
    'deepseek-flash',
    { ...usage, cost: 0.123 },
  )?.cost, 0.123);
  assert.equal(withEstimatedUsageCost('https://example.com', 'custom', usage)?.cost, undefined);
});
