import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGatewayServer } from './server.js';
import { ProviderType, Router, type ProviderTypeValue } from '../providers/router.js';
import { LocalProvider } from '../providers/local.js';
import { startTestServer } from '../test-support/server.js';
import type { Provider } from '../providers/provider.js';

async function boot(backendUrl: string, webRoot: string) {
  const providers = new Map<ProviderTypeValue, Provider>([
    [ProviderType.Local, new LocalProvider({ baseUrl: backendUrl })],
  ]);
  const server = createGatewayServer({ router: new Router(providers), webRoot });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the gateway serves health, api info, models, chat and the UI', async () => {
  const web = await mkdtemp(join(tmpdir(), 'tawx-web-'));
  await writeFile(join(web, 'index.html'), '<h1>TAWX</h1>');

  const backend = await startTestServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"object":"list","data":[{"id":"llama3","object":"model","created":0,"owned_by":"x"}]}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"cmpl-1","object":"chat.completion","model":"llama3","choices":[]}');
  });

  const gateway = await boot(backend.url, web);

  try {
    const health = await fetch(`${gateway.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const info = (await (await fetch(`${gateway.url}/v1`)).json()) as { endpoints: Record<string, string> };
    assert.equal(info.endpoints.chat_completions, 'POST /v1/chat/completions');

    const models = (await (await fetch(`${gateway.url}/v1/models`)).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(models.data.map((m) => m.id), ['llama3']);

    const completion = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(completion.status, 200);
    assert.equal(((await completion.json()) as { id: string }).id, 'cmpl-1');

    const ui = await fetch(`${gateway.url}/`);
    assert.equal(ui.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.equal(await ui.text(), '<h1>TAWX</h1>');
  } finally {
    await gateway.close();
    await backend.close();
    await rm(web, { recursive: true, force: true });
  }
});

test('the gateway streams SSE and terminates with [DONE]', async () => {
  const backend = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"llama3","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    );
  });
  const gateway = await boot(backend.url, tmpdir());

  try {
    const res = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3', messages: [], stream: true }),
    });

    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const body = await res.text();
    assert.match(body, /"content":"hi"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await gateway.close();
    await backend.close();
  }
});

test('unknown paths and wrong methods answer in the OpenAI error shape', async () => {
  const backend = await startTestServer((_req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  const gateway = await boot(backend.url, tmpdir());

  try {
    const notFound = await fetch(`${gateway.url}/nope`);
    assert.equal(notFound.status, 404);
    assert.match(((await notFound.json()) as { error: { message: string } }).error.message, /unknown path/);

    const wrongMethod = await fetch(`${gateway.url}/v1/models`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);

    const badJson = await fetch(`${gateway.url}/v1/chat/completions`, { method: 'POST', body: 'not json' });
    assert.equal(badJson.status, 400);
    assert.match(((await badJson.json()) as { error: { message: string } }).error.message, /invalid JSON/);
  } finally {
    await gateway.close();
    await backend.close();
  }
});
