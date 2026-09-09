import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRoutes, normalizeProvider } from '../src/lib/providers.ts';
import type { Provider } from '../src/types.ts';

test('legacy providers gain lifecycle defaults without losing their selected model', () => {
  const provider = normalizeProvider({
    id: 'legacy',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    model: 'deepseek/deepseek-chat',
  });

  assert.equal(provider.kind, 'openrouter');
  assert.equal(provider.authKind, 'bearer');
  assert.equal(provider.enabled, true);
  assert.equal(provider.connectionStatus, 'untested');
  assert.deepEqual(provider.discoveredModels, ['deepseek/deepseek-chat']);
});

test('model routes preserve provider identity for duplicate model ids', () => {
  const provider = (id: string, name: string): Provider => ({
    id,
    name,
    kind: id === 'router' ? 'openrouter' : 'openai-compatible',
    baseUrl: `https://${id}.example/v1`,
    authKind: 'bearer',
    apiKey: 'secret',
    enabled: true,
    model: 'deepseek-chat',
    discoveredModels: ['deepseek-chat'],
    connectionStatus: 'connected',
  });

  assert.deepEqual(modelRoutes([provider('direct', 'DeepSeek'), provider('router', 'OpenRouter')]), [
    { key: 'direct:deepseek-chat', providerId: 'direct', providerName: 'DeepSeek', model: 'deepseek-chat' },
    { key: 'router:deepseek-chat', providerId: 'router', providerName: 'OpenRouter', model: 'deepseek-chat' },
  ]);
});

test('disabled providers contribute no model routes', () => {
  const provider = normalizeProvider({
    id: 'local',
    name: 'Local',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: '',
    model: 'llama3.2',
    enabled: false,
  });

  assert.equal(provider.kind, 'ollama');
  assert.equal(provider.authKind, 'none');
  assert.deepEqual(modelRoutes([provider]), []);
});
