import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createGatewayServer } from './server.js';
import { ProviderType, Router, type ProviderTypeValue } from '../providers/router.js';
import { LocalProvider } from '../providers/local.js';
import { startTestServer } from '../test-support/server.js';
import type { Provider } from '../providers/provider.js';

async function boot() {
  const providers = new Map<ProviderTypeValue, Provider>([
    [ProviderType.Local, new LocalProvider({ baseUrl: 'http://127.0.0.1:1' })],
  ]);
  const server = createGatewayServer({ router: new Router(providers), webRoot: tmpdir() });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function proxied(gatewayUrl: string, target: string): string {
  return `${gatewayUrl}/proxy/remote?url=${encodeURIComponent(target)}`;
}

test('the proxy forwards a loopback provider request and its Authorization header', async () => {
  let seenAuth: string | undefined;
  let seenPath: string | undefined;
  const upstream = await startTestServer((req, res) => {
    seenAuth = req.headers.authorization;
    seenPath = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"deepseek-chat"}]}');
  });
  const gateway = await boot();

  try {
    const res = await fetch(proxied(gateway.url, `${upstream.url}/v1/models`), {
      headers: { Authorization: 'Bearer test-key' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = (await res.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(body.data.map((m) => m.id), ['deepseek-chat']);
    assert.equal(seenAuth, 'Bearer test-key');
    assert.equal(seenPath, '/v1/models');
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('the proxy passes an upstream error status and body through unchanged', async () => {
  const upstream = await startTestServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Authentication Fails"}}');
  });
  const gateway = await boot();

  try {
    const res = await fetch(proxied(gateway.url, `${upstream.url}/v1/models`));

    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(body.error.message, 'Authentication Fails');
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('the proxy streams SSE through without buffering', async () => {
  const upstream = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const gateway = await boot();

  try {
    const res = await fetch(proxied(gateway.url, `${upstream.url}/v1/chat/completions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [], stream: true }),
    });

    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    // Chunked passthrough: a buffered proxy would have set Content-Length.
    assert.equal(res.headers.get('content-length'), null);
    const body = await res.text();
    assert.match(body, /"content":"hi"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('the proxy forwards a POST body upstream', async () => {
  let seenBody = '';
  const upstream = await startTestServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seenBody = Buffer.concat(chunks).toString('utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"cmpl-1"}');
  });
  const gateway = await boot();

  try {
    const res = await fetch(proxied(gateway.url, `${upstream.url}/v1/chat/completions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 200);
    assert.match(seenBody, /"content":"hi"/);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('the proxy rejects plain-HTTP remote hosts and malformed URLs', async () => {
  const gateway = await boot();

  try {
    const insecure = await fetch(proxied(gateway.url, 'http://api.example.com/v1/models'));
    assert.equal(insecure.status, 400);
    assert.match(
      ((await insecure.json()) as { error: { message: string } }).error.message,
      /require HTTPS/,
    );

    const malformed = await fetch(proxied(gateway.url, 'not-a-url'));
    assert.equal(malformed.status, 400);
    assert.match(
      ((await malformed.json()) as { error: { message: string } }).error.message,
      /invalid provider URL/,
    );

    const missing = await fetch(`${gateway.url}/proxy/remote`);
    assert.equal(missing.status, 400);

    // Embedded credentials would leak into the upstream request.
    const withUser = await fetch(proxied(gateway.url, 'https://user:pass@api.example.com/v1/models'));
    assert.equal(withUser.status, 400);
  } finally {
    await gateway.close();
  }
});

test('the proxy rejects methods other than GET and POST', async () => {
  const gateway = await boot();

  try {
    const res = await fetch(proxied(gateway.url, 'https://api.example.com/v1/models'), {
      method: 'DELETE',
    });
    assert.equal(res.status, 405);
  } finally {
    await gateway.close();
  }
});

test('the proxy answers an unreachable provider with 502', async () => {
  const upstream = await startTestServer((_req, res) => {
    res.end();
  });
  const deadUrl = upstream.url;
  await upstream.close();
  const gateway = await boot();

  try {
    const res = await fetch(proxied(gateway.url, `${deadUrl}/v1/models`));
    assert.equal(res.status, 502);
    assert.match(
      ((await res.json()) as { error: { message: string } }).error.message,
      /provider connection failed/,
    );
  } finally {
    await gateway.close();
  }
});
