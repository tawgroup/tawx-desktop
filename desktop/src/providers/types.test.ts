import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeTool } from './types.js';

test('server tool JSON omits function', () => {
  const json = JSON.stringify(serializeTool({ type: 'openrouter:web_search', parameters: { engine: 'exa' } }));
  assert.equal(json, '{"type":"openrouter:web_search","parameters":{"engine":"exa"}}');
});

test('function tool JSON is unchanged', () => {
  const tool = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } };
  assert.deepEqual(serializeTool(tool), tool);
});
