import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterProvider } from './openrouter.js';
import { readBody, startTestServer } from '../test-support/server.js';
import type { ChatCompletionRequest } from './types.js';

test('OpenRouter strips the selector prefix and requests usage when streaming', async () => {
  const seen: ChatCompletionRequest[] = [];

  const server = await startTestServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as ChatCompletionRequest;
    seen.push(body);

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"ok","object":"chat.completion","model":"moonshotai/kimi-k3","choices":[]}');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });

    await provider.chatCompletion({
      model: 'openrouter/moonshotai/kimi-k3',
      messages: [{ role: 'user', content: 'hello' }],
    });

    for await (const _chunk of provider.chatCompletionStream({
      model: 'openrouter/moonshotai/kimi-k3',
      messages: [],
    })) {
      // drained; the server only sends [DONE]
    }

    assert.equal(seen.length, 2);
    for (const body of seen) assert.equal(body.model, 'moonshotai/kimi-k3');
    assert.equal(seen[0]?.stream, false);
    assert.equal(seen[1]?.stream, true);
    assert.equal(seen[1]?.stream_options?.include_usage, true);
  } finally {
    await server.close();
  }
});

test('OpenRouter re-prefixes model ids from listModels', async () => {
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"moonshotai/kimi-k3","object":"model","created":0,"owned_by":"moonshotai"}]}');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    const models = await provider.listModels();
    assert.deepEqual(models.map((m) => m.id), ['openrouter/moonshotai/kimi-k3']);
  } finally {
    await server.close();
  }
});
