import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from './anthropic.js';
import { CursorProvider } from './cursor.js';
import { ApiError } from './errors.js';
import { GoogleProvider } from './google.js';
import { LocalProvider } from './local.js';
import { OpenAiProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import { createProvider, PROVIDER_KINDS, ProviderKind, providerKinds } from './kinds.js';

test('every kind constructs its adapter', () => {
  const spec = { apiKey: 'k', baseUrl: 'https://example.test/v1' };

  assert.ok(createProvider(ProviderKind.OpenAiCompatible, spec) instanceof OpenAiProvider);
  assert.ok(createProvider(ProviderKind.Google, spec) instanceof GoogleProvider);
  assert.ok(createProvider(ProviderKind.OpenRouter, spec) instanceof OpenRouterProvider);
  assert.ok(createProvider(ProviderKind.Anthropic, spec) instanceof AnthropicProvider);
  assert.ok(createProvider(ProviderKind.Cursor, spec) instanceof CursorProvider);
  assert.ok(createProvider(ProviderKind.Ollama, spec) instanceof LocalProvider);
});

test('an unknown kind is a client error, not a crash', () => {
  assert.throws(() => createProvider('gemini', {}), ApiError);
});

test('an adapter can be built without an API key', () => {
  // Ollama and LM Studio are unauthenticated; the registry must not require a key.
  assert.ok(createProvider(ProviderKind.Ollama, { baseUrl: 'http://localhost:11434' }));
});

test('the kind list and the constructor record stay in step', () => {
  assert.deepEqual(providerKinds().sort(), Object.keys(PROVIDER_KINDS).sort());
  assert.deepEqual(providerKinds().sort(), [
    'anthropic',
    'cursor',
    'google',
    'ollama',
    'openai-compatible',
    'openrouter',
  ]);
});

/**
 * The frontend tags each configured provider with a kind (frontend/src/types.ts
 * ProviderKind). Its `gateway` kind is frontend-only — it means "this same
 * server's /v1" and has no adapter — but every other value must resolve here,
 * or the Settings UI can offer a provider the backend cannot build.
 */
test('the frontend kind vocabulary is covered', () => {
  const frontendKinds = ['gateway', 'openrouter', 'openai-compatible', 'ollama'];
  for (const kind of frontendKinds) {
    if (kind === 'gateway') continue;
    assert.ok(createProvider(kind, { apiKey: 'k' }), `no adapter for frontend kind '${kind}'`);
  }
});
