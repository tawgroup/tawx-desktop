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
    const { provider, providerType } = new Router(allProviders()).route(model);
    assert.equal(providerType, want);
    assert.ok(provider);
  });
}

test('route fails when the resolved provider is not configured', () => {
  const router = new Router(new Map<ProviderTypeValue, Provider>([[ProviderType.Local, new MockProvider('local')]]));

  assert.throws(() => router.route('gpt-4'), ApiError);
  assert.throws(() => router.route('claude-3-opus'), ApiError);

  const { provider, providerType } = router.route('llama2');
  assert.equal(providerType, ProviderType.Local);
  assert.ok(provider);
});
