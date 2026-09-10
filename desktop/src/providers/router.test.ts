import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderType, Router, type ProviderTypeValue } from './router.js';
import { ApiError } from './errors.js';
import type { Provider } from './provider.js';
import type { ChatCompletionResponse, Model, StreamChunk } from './types.js';

/** Minimal Provider implementation; Route only ever checks identity. */
class MockProvider implements Provider {
  constructor(readonly name: string) {}
  async chatCompletion(): Promise<ChatCompletionResponse> {
    throw new Error('not used');
  }
  async *chatCompletionStream(): AsyncGenerator<StreamChunk> {
    throw new Error('not used');
  }
  async listModels(): Promise<Model[]> {
    return [];
  }
}

const allProviders = () =>
  new Map<ProviderTypeValue, Provider>([
    [ProviderType.OpenAi, new MockProvider('openai')],
    [ProviderType.OpenRouter, new MockProvider('openrouter')],
    [ProviderType.Anthropic, new MockProvider('anthropic')],
    [ProviderType.Local, new MockProvider('local')],
  ]);

const cases: Array<[string, ProviderTypeValue]> = [
  ['gpt-4', ProviderType.OpenAi],
  ['gpt-4-turbo', ProviderType.OpenAi],
  ['gpt-3.5-turbo', ProviderType.OpenAi],
  ['GPT-4', ProviderType.OpenAi], // case insensitive
  ['o1-preview', ProviderType.OpenAi],
  ['o1-mini', ProviderType.OpenAi],
  ['o3-mini', ProviderType.OpenAi],
  ['openrouter/moonshotai/kimi-k3', ProviderType.OpenRouter],
  ['claude-3-opus-20240229', ProviderType.Anthropic],
  ['claude-3-sonnet-20240229', ProviderType.Anthropic],
  ['claude-3-haiku-20240307', ProviderType.Anthropic],
  ['claude-3-5-sonnet-20241022', ProviderType.Anthropic],
  ['CLAUDE-3-opus', ProviderType.Anthropic], // case insensitive
  ['llama2', ProviderType.Local],
  ['llama3', ProviderType.Local],
  ['mistral', ProviderType.Local],
  ['mixtral', ProviderType.Local],
  ['codellama', ProviderType.Local],
  ['phi3', ProviderType.Local],
  ['qwen2', ProviderType.Local],
  ['custom-model', ProviderType.Local],
];

for (const [model, want] of cases) {
  test(`route ${model}`, () => {
    const { provider, providerId } = new Router(allProviders()).route(model);
    assert.equal(providerId, want);
    assert.ok(provider);
  });
}

test('route fails when the resolved provider is not configured', () => {
  const router = new Router(new Map<ProviderTypeValue, Provider>([[ProviderType.Local, new MockProvider('local')]]));

  assert.throws(() => router.route('gpt-4'), ApiError);
  assert.throws(() => router.route('claude-3-opus'), ApiError);

  const { provider, providerId } = router.route('llama2');
  assert.equal(providerId, ProviderType.Local);
  assert.ok(provider);
});

test('a <providerId>/<model> selector picks the provider and is stripped from the model', () => {
  const router = new Router(allProviders());

  const openai = router.route('openai/gpt-4o-mini');
  assert.equal(openai.providerId, ProviderType.OpenAi);
  assert.equal(openai.model, 'gpt-4o-mini');

  // Only the first slash is a separator — OpenRouter ids carry their own.
  const openrouter = router.route('openrouter/moonshotai/kimi-k3');
  assert.equal(openrouter.providerId, ProviderType.OpenRouter);
  assert.equal(openrouter.model, 'moonshotai/kimi-k3');

  // A selector beats the name-sniffing rules: a claude- model served by an
  // OpenAI-compatible endpoint must not be dragged to the Anthropic adapter.
  const viaLocal = router.route('local/claude-3-opus');
  assert.equal(viaLocal.providerId, ProviderType.Local);
  assert.equal(viaLocal.model, 'claude-3-opus');
});

test('a slash that does not name a configured provider is part of the model', () => {
  const router = new Router(allProviders());

  // Together's model ids look like a selector but are not one.
  const route = router.route('meta-llama/Llama-3.3-70B-Instruct-Turbo');
  assert.equal(route.providerId, ProviderType.Local);
  assert.equal(route.model, 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
});

test('two providers of the same kind coexist behind distinct ids', () => {
  const deepseek = new MockProvider('deepseek');
  const groq = new MockProvider('groq');
  const router = new Router([
    { id: 'deepseek', provider: deepseek },
    { id: 'groq', provider: groq },
  ]);

  assert.equal(router.route('deepseek/deepseek-chat').provider, deepseek);
  assert.equal(router.route('groq/llama-3.3-70b-versatile').provider, groq);
  assert.deepEqual(router.instances().map((i) => i.id), ['deepseek', 'groq']);
});
