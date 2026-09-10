import assert from 'node:assert/strict';
import test from 'node:test';
import { isProviderRoutable, qualifyModel, resolveProviderCall } from '../src/lib/providers.ts';
import type { Provider } from '../src/types.ts';

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    authKind: 'bearer',
    apiKey: '',
    enabled: true,
    model: 'deepseek-chat',
    discoveredModels: ['deepseek-chat', 'deepseek-reasoner'],
    connectionStatus: 'connected',
    ...overrides,
  };
}

test('a managed provider is routable on hasApiKey, never on the absent apiKey', () => {
  // The renderer holds no key for a managed provider, so the old
  // `apiKey.length > 0` test would call every one of them unusable.
  assert.equal(isProviderRoutable(provider({ ownership: 'managed', hasApiKey: true })), true);
  assert.equal(isProviderRoutable(provider({ ownership: 'managed', hasApiKey: false })), false);
  assert.equal(
    isProviderRoutable(provider({ ownership: 'managed', hasApiKey: false, authKind: 'none' })),
    true,
    'a provider that needs no key stays routable',
  );
  assert.equal(
    isProviderRoutable(provider({ ownership: 'managed', hasApiKey: true, enabled: false })),
    false,
  );
});

test('a local provider still needs the key it holds itself', () => {
  assert.equal(isProviderRoutable(provider({ apiKey: 'sk-local' })), true);
  assert.equal(isProviderRoutable(provider({ apiKey: '' })), false);
  assert.equal(isProviderRoutable(provider({ apiKey: '   ' })), false);
});

test('a managed provider is rewritten into a gateway call', () => {
  const call = resolveProviderCall(provider({ ownership: 'managed', hasApiKey: true }));

  assert.equal(call.baseUrl, '/v1', 'requests must go to this server, not the vendor');
  assert.equal(call.authKind, 'none');
  assert.equal(call.apiKey, '', 'no key may be attached from the renderer');
  assert.equal(call.model, 'deepseek/deepseek-chat');
  assert.deepEqual(call.discoveredModels, [
    'deepseek/deepseek-chat',
    'deepseek/deepseek-reasoner',
  ]);
});

test('a local provider is left alone and still called directly', () => {
  const original = provider({ apiKey: 'sk-local' });
  assert.deepEqual(resolveProviderCall(original), original);
});

test('qualifying a model is idempotent', () => {
  assert.equal(qualifyModel('deepseek', 'deepseek-chat'), 'deepseek/deepseek-chat');
  assert.equal(qualifyModel('deepseek', 'deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
  // OpenRouter ids carry slashes of their own; only the provider prefix is added.
  assert.equal(qualifyModel('openrouter', 'openai/gpt-4o-mini'), 'openrouter/openai/gpt-4o-mini');
  assert.equal(qualifyModel('openrouter', 'openrouter/openai/gpt-4o-mini'), 'openrouter/openai/gpt-4o-mini');
  assert.equal(qualifyModel('deepseek', ''), '');
});

test('rewriting twice does not double the prefix', () => {
  const once = resolveProviderCall(provider({ ownership: 'managed', hasApiKey: true }));
  const twice = resolveProviderCall(once);
  assert.equal(twice.model, 'deepseek/deepseek-chat');
  assert.deepEqual(twice.discoveredModels, once.discoveredModels);
});
