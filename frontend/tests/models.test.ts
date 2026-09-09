import assert from 'node:assert/strict';
import test from 'node:test';
import { filterModels } from '../src/lib/models.ts';
import { completionBody } from '../src/lib/api.ts';
import { chatMode } from '../src/types.ts';

test('filterModels deduplicates, searches, and keeps auto first', () => {
  assert.deepEqual(filterModels(['z-model', 'auto', 'a-model', 'auto'], ''), ['auto', 'a-model', 'z-model']);
  assert.deepEqual(filterModels(['gpt-5.6-sol', 'deepseek-v4-flash'], 'GPT'), ['gpt-5.6-sol']);
});

test('legacy and new conversations stay in their own modes', () => {
  const base = { id: '1', title: 'x', createdAt: 1, updatedAt: 1 };
  assert.equal(chatMode(base), 'chat');
  assert.equal(chatMode({ ...base, mode: 'code' }), 'code');
});

test('completionBody adds one bounded OpenRouter web-search tool', () => {
  const body = completionBody({
    model: 'openrouter/test',
    messages: [{ role: 'user', content: 'latest news' }],
    webSearch: 'exa',
  }, true);
  assert.deepEqual(body.tools, [{
    type: 'openrouter:web_search',
    parameters: { engine: 'exa', max_uses: 1, max_results: 3 },
  }]);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal('stream_options' in completionBody({
    model: 'openrouter/test',
    messages: [{ role: 'user', content: 'hello' }],
  }, false), false);
});
