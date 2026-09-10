import assert from 'node:assert/strict';
import test from 'node:test';
import { filterModels } from '../src/lib/models.ts';
import { completionBody } from '../src/lib/api.ts';
import { chatMode, DEFAULT_SETTINGS } from '../src/types.ts';

test('filterModels deduplicates, searches, and keeps auto first', () => {
  assert.deepEqual(filterModels(['z-model', 'auto', 'a-model', 'auto'], ''), ['auto', 'a-model', 'z-model']);
  assert.deepEqual(filterModels(['gpt-5.6-sol', 'deepseek-v4-flash'], 'GPT'), ['gpt-5.6-sol']);
});

test('legacy and new conversations stay in their own modes', () => {
  const base = { id: '1', title: 'x', createdAt: 1, updatedAt: 1 };
  assert.equal(chatMode(base), 'chat');
  assert.equal(chatMode({ ...base, mode: 'code' }), 'code');
});

test('web search is on out of the box, and the search itself stays bounded', () => {
  // A deliberate cost decision: the tool rides along on every OpenRouter
  // answer, and the model pays for a search only when it calls one.
  assert.equal(DEFAULT_SETTINGS.webSearch, true);
  assert.equal(DEFAULT_SETTINGS.webSearchEngine, 'auto');
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
