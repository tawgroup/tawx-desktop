import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createProvidersHttpHandler } from './http.js';
import { ProviderRuntime } from './registry.js';
import { Router } from './router.js';
import { identityCipher } from '../test-support/cipher.js';

/**
 * The handler is exercised directly rather than through createGatewayServer,
 * whose `desktop` option needs a real TaskRuntime. The same-origin guard that
 * fronts /desktop/ in production is server.ts's, and is tested there.
 */
async function boot() {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-providers-http-'));
  const router = new Router([]);
  const runtime = await ProviderRuntime.open({ directory, router, cipher: identityCipher() });
  const handler = createProvidersHttpHandler(runtime);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handler({ request: req, response: res, url })) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"not handled"}}');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    router,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-http-secret',
  model: 'deepseek-chat',
};

async function post(url: string, body: unknown, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('providers can be listed, created, patched and deleted', async () => {
  const app = await boot();

  try {
    const empty = (await (await fetch(`${app.url}/desktop/providers`)).json()) as {
      providers: unknown[];
    };
    assert.deepEqual(empty.providers, []);

    const created = await post(`${app.url}/desktop/providers`, DEEPSEEK);
    assert.equal(created.status, 201);
    const { provider } = (await created.json()) as { provider: { id: string; hasApiKey: boolean } };
    assert.equal(provider.id, 'deepseek');
    assert.equal(provider.hasApiKey, true);
    assert.ok(app.router.has('deepseek'));

    const patched = await post(`${app.url}/desktop/providers/deepseek`, { name: 'DS' }, 'PATCH');
    assert.equal(patched.status, 200);
    const renamed = (await patched.json()) as { provider: { name: string; hasApiKey: boolean } };
    assert.equal(renamed.provider.name, 'DS');
    assert.equal(renamed.provider.hasApiKey, true);

    const deleted = await fetch(`${app.url}/desktop/providers/deepseek`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(app.router.has('deepseek'), false);
  } finally {
    await app.close();
  }
});

test('no response ever carries the API key', async () => {
  const app = await boot();

  try {
    const created = await post(`${app.url}/desktop/providers`, DEEPSEEK);
    assert.equal((await created.text()).includes('sk-http-secret'), false);

    const listed = await fetch(`${app.url}/desktop/providers`);
    assert.equal((await listed.text()).includes('sk-http-secret'), false);

    const one = await fetch(`${app.url}/desktop/providers/deepseek`);
    assert.equal((await one.text()).includes('sk-http-secret'), false);
  } finally {
    await app.close();
  }
});

test('a duplicate id is a client error, not a silent overwrite', async () => {
  const app = await boot();

  try {
    assert.equal((await post(`${app.url}/desktop/providers`, DEEPSEEK)).status, 201);
    const again = await post(`${app.url}/desktop/providers`, DEEPSEEK);
    assert.equal(again.status, 400);
    assert.match(
      ((await again.json()) as { error: { message: string } }).error.message,
      /already exists/,
    );
  } finally {
    await app.close();
  }
});

test('a missing provider is 404 and a bad body is 400', async () => {
  const app = await boot();

  try {
    assert.equal((await fetch(`${app.url}/desktop/providers/nope`)).status, 404);
    assert.equal((await post(`${app.url}/desktop/providers/nope`, {}, 'PATCH')).status, 404);
    assert.equal((await fetch(`${app.url}/desktop/providers/nope`, { method: 'DELETE' })).status, 404);

    const badJson = await fetch(`${app.url}/desktop/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    assert.equal(badJson.status, 400);

    const badUrl = await post(`${app.url}/desktop/providers`, {
      name: 'X',
      kind: 'openai-compatible',
      baseUrl: 'http://api.example.com/v1',
    });
    assert.equal(badUrl.status, 400);
    assert.match(
      ((await badUrl.json()) as { error: { message: string } }).error.message,
      /require HTTPS/,
    );
  } finally {
    await app.close();
  }
});

test('wrong methods answer 405 and unrelated paths are not claimed', async () => {
  const app = await boot();

  try {
    assert.equal((await fetch(`${app.url}/desktop/providers`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${app.url}/desktop/providers/x/test`)).status, 405);

    // The handler must decline paths that are not its own, so the next
    // DesktopHttpHandler in the chain still gets a turn.
    const other = await fetch(`${app.url}/desktop/schedules`);
    assert.equal(other.status, 404);
    assert.match(((await other.json()) as { error: { message: string } }).error.message, /not handled/);
  } finally {
    await app.close();
  }
});

test('the test endpoint records the probe result', async () => {
  const app = await boot();

  try {
    await post(`${app.url}/desktop/providers`, {
      name: 'Dead',
      id: 'dead',
      kind: 'openai-compatible',
      baseUrl: 'https://127.0.0.1:1',
      apiKey: 'sk-x',
    });

    const tested = await post(`${app.url}/desktop/providers/dead/test`, {});
    assert.equal(tested.status, 200);
    const { provider } = (await tested.json()) as {
      provider: { connectionStatus: string; lastError?: string };
    };
    assert.equal(provider.connectionStatus, 'error');
    assert.ok(provider.lastError);
  } finally {
    await app.close();
  }
});
