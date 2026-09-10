import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './errors.js';
import { ProviderRuntime } from './registry.js';
import { ProviderType, Router } from './router.js';
import { identityCipher, unreadableCipher } from '../test-support/cipher.js';
import { startTestServer } from '../test-support/server.js';
import { LocalProvider } from './local.js';
import type { Provider } from './provider.js';
import type { ProviderTypeValue } from './router.js';

async function open(options: { cipher?: ReturnType<typeof identityCipher>; config?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-providers-'));
  const configured = new Map<ProviderTypeValue, Provider>(
    options.config ? [[ProviderType.Local, new LocalProvider({ baseUrl: 'http://127.0.0.1:1' })]] : [],
  );
  const router = new Router(configured);
  const runtime = await ProviderRuntime.open({
    directory,
    router,
    cipher: options.cipher ?? identityCipher(),
    configIds: [...configured.keys()],
  });
  return { runtime, router, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('a created provider becomes routable on the router main.ts already holds', async () => {
  const { runtime, router, cleanup } = await open();

  try {
    // The router reference is captured by the HTTP server and the agent runtime
    // at startup, so mutation must be in place — not a replacement instance.
    assert.throws(() => router.route('deepseek/deepseek-chat'), ApiError);

    const created = await runtime.create({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
    });
    assert.equal(created.id, 'deepseek');

    const route = router.route('deepseek/deepseek-chat');
    assert.equal(route.providerId, 'deepseek');
    assert.equal(route.model, 'deepseek-chat');

    await runtime.remove('deepseek');
    assert.throws(() => router.route('deepseek/deepseek-chat'), ApiError);
  } finally {
    await cleanup();
  }
});

test('the API key is never returned, only whether one is held', async () => {
  const { runtime, cleanup } = await open();

  try {
    const created = await runtime.create({
      id: 'groq',
      name: 'Groq',
      kind: 'openai-compatible',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'sk-secret-value',
    });

    assert.equal(created.hasApiKey, true);
    assert.equal(JSON.stringify(created).includes('sk-secret-value'), false);
    assert.equal(JSON.stringify(runtime.list()).includes('sk-secret-value'), false);
  } finally {
    await cleanup();
  }
});

test('the key is written to disk as ciphertext, never in the clear', async () => {
  const { runtime, directory, cleanup } = await open();

  try {
    await runtime.create({
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-on-disk',
    });

    const raw = await readFile(join(directory, 'providers.json'), 'utf8');
    assert.equal(raw.includes('sk-on-disk'), false);
    assert.match(raw, /b64:/); // the test cipher's marker
  } finally {
    await cleanup();
  }
});

test('PATCH keeps, clears or replaces the key by whether apiKey is present', async () => {
  const { runtime, cleanup } = await open();

  try {
    const created = await runtime.create({
      id: 'together',
      name: 'Together',
      kind: 'openai-compatible',
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: 'sk-first',
    });
    assert.equal(created.hasApiKey, true);

    const renamed = await runtime.update('together', { name: 'Together AI' });
    assert.equal(renamed.name, 'Together AI');
    assert.equal(renamed.hasApiKey, true, 'an absent apiKey must keep the stored one');

    const cleared = await runtime.update('together', { apiKey: '' });
    assert.equal(cleared.hasApiKey, false);

    const replaced = await runtime.update('together', { apiKey: 'sk-second' });
    assert.equal(replaced.hasApiKey, true);
  } finally {
    await cleanup();
  }
});

test('changing the upstream address invalidates a previous probe', async () => {
  const upstream = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"m1","architecture":{"input_modalities":["text","image"]}},{"id":"m2","architecture":{"input_modalities":["text"]}}]}');
  });
  const { runtime, cleanup } = await open();

  try {
    await runtime.create({
      id: 'lmstudio',
      name: 'LM Studio',
      kind: 'ollama',
      baseUrl: upstream.url,
    });

    const tested = await runtime.test('lmstudio');
    assert.equal(tested.connectionStatus, 'connected');
    assert.deepEqual(tested.discoveredModels, ['m1', 'm2']);
    assert.deepEqual(tested.visionModels, ['m1']);

    const moved = await runtime.update('lmstudio', { baseUrl: 'http://127.0.0.1:1' });
    assert.equal(moved.connectionStatus, 'untested');
    assert.deepEqual(moved.discoveredModels, []);
    assert.deepEqual(moved.visionModels, []);
    assert.equal(moved.lastError, undefined);
  } finally {
    await cleanup();
    await upstream.close();
  }
});

test('a failed probe is recorded on the provider, not thrown', async () => {
  const { runtime, cleanup } = await open();

  try {
    await runtime.create({
      id: 'dead',
      name: 'Dead',
      kind: 'openai-compatible',
      baseUrl: 'https://127.0.0.1:1',
      apiKey: 'sk-x',
    });

    const tested = await runtime.test('dead');
    assert.equal(tested.connectionStatus, 'error');
    assert.ok(tested.lastError);
  } finally {
    await cleanup();
  }
});

test('a disabled provider is not routable', async () => {
  const { runtime, router, cleanup } = await open();

  try {
    await runtime.create({
      id: 'paused',
      name: 'Paused',
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
    });
    assert.ok(router.has('paused'));

    await runtime.update('paused', { enabled: false });
    assert.equal(router.has('paused'), false);

    await runtime.update('paused', { enabled: true });
    assert.ok(router.has('paused'));
  } finally {
    await cleanup();
  }
});

test('an id that cannot be a selector segment is rejected', async () => {
  const { runtime, cleanup } = await open();

  const base = {
    name: 'X',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
  };

  try {
    // A slash would split inside `<providerId>/<model>`.
    await assert.rejects(() => runtime.create({ ...base, id: 'a/b' }), ApiError);
    await assert.rejects(() => runtime.create({ ...base, id: '' , name: 'X'}), ApiError);
    await assert.rejects(() => runtime.create({ ...base, id: '-leading' }), ApiError);
    await assert.rejects(() => runtime.create({ ...base, id: 'a'.repeat(65) }), ApiError);
  } finally {
    await cleanup();
  }
});

test('a config-file provider id cannot be shadowed', async () => {
  const { runtime, cleanup } = await open({ config: true });

  try {
    assert.deepEqual(
      runtime.list().map((view) => [view.id, view.source, view.readOnly]),
      [['local', 'config', true]],
    );

    await assert.rejects(
      () =>
        runtime.create({
          id: 'local',
          name: 'Mine',
          kind: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-x',
        }),
      ApiError,
    );
  } finally {
    await cleanup();
  }
});

test('an invalid kind or base URL is refused', async () => {
  const { runtime, cleanup } = await open();

  try {
    await assert.rejects(
      () => runtime.create({ name: 'X', kind: 'gemini', baseUrl: 'https://api.example.com/v1' }),
      ApiError,
    );
    await assert.rejects(
      () =>
        runtime.create({ name: 'X', kind: 'openai-compatible', baseUrl: 'http://api.example.com/v1' }),
      ApiError,
    );
    await assert.rejects(
      () => runtime.create({ name: '  ', kind: 'openai-compatible', baseUrl: 'https://a.example/v1' }),
      ApiError,
    );
  } finally {
    await cleanup();
  }
});

test('providers survive a restart and remount onto a fresh router', async () => {
  const { runtime, directory, cleanup } = await open();

  try {
    await runtime.create({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
    });

    const router = new Router([]);
    const reopened = await ProviderRuntime.open({ directory, router, cipher: identityCipher() });

    assert.equal(reopened.list().length, 1);
    assert.equal(router.route('deepseek/deepseek-chat').providerId, 'deepseek');
  } finally {
    await cleanup();
  }
});

test('a key this build cannot decrypt reads as absent and is not routable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-providers-'));

  try {
    // Written by one keychain…
    const writer = await ProviderRuntime.open({
      directory,
      router: new Router([]),
      cipher: identityCipher(),
    });
    await writer.create({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    });

    // …and read by another, as a packaged build reads a dev run's file.
    const router = new Router([]);
    const reader = await ProviderRuntime.open({ directory, router, cipher: unreadableCipher() });

    assert.equal(reader.list()[0]?.hasApiKey, false, 'the user must be told to re-enter it');
    assert.equal(router.has('deepseek'), false, 'an unusable provider must not be routable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a provider is refused when no keychain is available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-providers-'));

  try {
    const runtime = await ProviderRuntime.open({
      directory,
      router: new Router([]),
      cipher: { available: () => false, encrypt: () => '', decrypt: () => undefined },
    });

    // Silently storing plaintext would be the worse failure.
    await assert.rejects(
      () =>
        runtime.create({
          name: 'DeepSeek',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-test',
        }),
      ApiError,
    );

    // One that needs no key is still fine.
    const ollama = await runtime.create({
      name: 'Ollama',
      kind: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    });
    assert.equal(ollama.hasApiKey, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * The regression that motivated adapterBaseUrl: the Settings field asks for a
 * URL "including /v1" while the adapters append `/v1/...` themselves, so every
 * migrated provider was reaching `/v1/v1/chat/completions`. Asserting the exact
 * path is the only way to see it — a mock that answers any URL cannot.
 */
test('the upstream is reached at /v1/... exactly once, whichever form the URL took', async () => {
  const paths: string[] = [];
  const upstream = await startTestServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"m1"}]}');
  });

  for (const [suffix, label] of [['/v1', 'with /v1'], ['', 'without /v1']] as const) {
    const { runtime, cleanup } = await open();
    try {
      await runtime.create({
        id: 'probe',
        name: 'Probe',
        kind: 'ollama',
        baseUrl: `${upstream.url}${suffix}`,
      });
      const tested = await runtime.test('probe');
      assert.equal(tested.connectionStatus, 'connected', label);
    } finally {
      await cleanup();
    }
  }

  await upstream.close();
  assert.deepEqual(paths, ['/v1/models', '/v1/models']);
});

test('the stored base URL keeps the form the user typed', async () => {
  const { runtime, cleanup } = await open();

  try {
    // Settings must show what was entered, not an internally rewritten base.
    const created = await runtime.create({
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-x',
    });
    assert.equal(created.baseUrl, 'https://api.deepseek.com/v1');
  } finally {
    await cleanup();
  }
});
