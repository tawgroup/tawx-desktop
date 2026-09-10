import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeMessageImages, configuredModelCapability, configuredVisionRoute, needsVisionFallback } from '../src/lib/vision.ts';
import { DEFAULT_SETTINGS, type Message, type Provider, type Settings } from '../src/types.ts';

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: '/v1',
    authKind: 'none',
    apiKey: '',
    enabled: true,
    model: 'deepseek/deepseek-chat-v3.1',
    discoveredModels: [],
    visionModels: [],
    connectionStatus: 'connected',
    ...patch,
  };
}

function settings(route: Provider, patch: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    providers: [route],
    activeProviderId: route.id,
    visionProviderId: route.id,
    ...patch,
  };
}

test('capability metadata and explicit overrides decide whether Chat needs fallback', () => {
  const route = provider({ model: 'google/gemini-3.1-flash-lite', visionModels: ['google/gemini-3.1-flash-lite'] });
  const automatic = settings(route);
  assert.equal(configuredModelCapability(automatic, route), 'vision');
  assert.equal(needsVisionFallback('chat', automatic, route), false);
  assert.equal(needsVisionFallback('cowork', automatic, route), true);

  const forcedText = settings(route, {
    modelCapabilityOverrides: { [`${route.id}:${route.model}`]: 'text-only' },
  });
  assert.equal(configuredModelCapability(forcedText, route), 'text-only');
  assert.equal(needsVisionFallback('chat', forcedText, route), true);

  const unknown = provider({ model: 'custom-model' });
  assert.equal(configuredModelCapability(settings(unknown), unknown), 'text-only');
});

test('managed vision routes keep credentials in the desktop and qualify the model', () => {
  const route = provider({ ownership: 'managed', hasApiKey: true });
  const selected = configuredVisionRoute(settings(route, { visionModel: 'google/gemini-3.1-flash-lite' }));
  assert.ok(selected);
  assert.equal(selected.callProvider.baseUrl, '/v1');
  assert.equal(selected.callProvider.apiKey, '');
  assert.equal(selected.model, 'openrouter/google/gemini-3.1-flash-lite');
});

test('one vision request carries every image and records reusable provenance', async () => {
  const route = provider({ model: 'google/gemini-3.1-flash-lite' });
  const configured = settings(route, { visionModel: route.model });
  const message: Message = {
    id: 'message',
    chatId: 'chat',
    role: 'user',
    content: 'Compare the two errors',
    attachments: [
      { id: 'one', name: 'one.png', mimeType: 'image/png', size: 4, kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      { id: 'two', name: 'two.png', mimeType: 'image/png', size: 4, kind: 'image', dataUrl: 'data:image/png;base64,BBBB' },
    ],
    createdAt: 1,
  };
  let requestBody: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: 'google/gemini-3.1-flash-lite',
      choices: [{ message: { content: 'RELEVANT_TEXT:\n- Error A differs from Error B' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0004 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const analyzed = await analyzeMessageImages(message, configured);
    const wireMessages = requestBody?.messages as Array<{ content: Array<{ type: string; text?: string }> }>;
    assert.equal(wireMessages[0].content.filter((part) => part.type === 'image_url').length, 2);
    assert.match(wireMessages[0].content[0].text ?? '', /Compare the two errors/);
    assert.equal(requestBody?.reasoning_effort, 'none');
    assert.equal(requestBody?.max_tokens, 600);
    assert.deepEqual(analyzed.visionAnalysis?.attachmentIds, ['one', 'two']);
    assert.equal(analyzed.visionAnalysis?.providerName, 'OpenRouter');
    assert.equal(analyzed.visionAnalysis?.inputTokens, 100);
    assert.equal(analyzed.visionAnalysis?.outputTokens, 20);
    assert.equal(analyzed.visionAnalysis?.cost, 0.0004);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
