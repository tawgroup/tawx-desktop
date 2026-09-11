import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterProvider, translateWebSearch } from './openrouter.js';
import { readBody, startTestServer } from '../test-support/server.js';
import type { ChatCompletionRequest } from './types.js';

test('OpenRouter passes the model through and requests usage when streaming', async () => {
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
      // Router has already stripped the `openrouter/` selector by this point.
      model: 'moonshotai/kimi-k3',
      messages: [{ role: 'user', content: 'hello' }],
    });

    for await (const _chunk of provider.chatCompletionStream({
      model: 'moonshotai/kimi-k3',
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

/**
 * Prefixing moved to /v1/models, which qualifies every id as
 * `<providerId>/<model>`. The adapter reporting OpenRouter's own ids is what
 * lets that single rule apply to every provider alike.
 */
test('OpenRouter reports upstream model ids unchanged', async () => {
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"object":"list","data":[{"id":"moonshotai/kimi-k3","object":"model","created":0,"owned_by":"moonshotai"}]}');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    const models = await provider.listModels();
    assert.deepEqual(models.map((m) => m.id), ['moonshotai/kimi-k3']);
  } finally {
    await server.close();
  }
});

test('the web-search tool becomes the web plugin', () => {
  // The fallback transform, for when OpenRouter refuses the server tool.
  const translated = translateWebSearch({
    model: 'deepseek/deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'openrouter:web_search', parameters: { engine: 'exa', max_uses: 1, max_results: 3 } }],
  });

  assert.deepEqual(translated.plugins, [{ id: 'web', engine: 'exa', max_results: 3 }]);
  assert.equal(translated.tools, undefined, 'the tool it replaced must not also be sent');
});

test("the frontend's 'auto' engine is an omission, not a value", () => {
  // The plugin rejects "auto" with a 400; it is the UI's word for no preference.
  const translated = translateWebSearch({
    model: 'm',
    messages: [],
    tools: [{ type: 'openrouter:web_search', parameters: { engine: 'auto', max_results: 3 } }],
  });
  assert.deepEqual(translated.plugins, [{ id: 'web', max_results: 3 }]);
});

test('ordinary tools survive alongside a web search', () => {
  const weather = { type: 'function', function: { name: 'get_weather' } };
  const translated = translateWebSearch({
    model: 'm',
    messages: [],
    tools: [weather, { type: 'openrouter:web_search', parameters: { engine: 'auto' } }],
  });
  assert.deepEqual(translated.tools, [weather]);
  assert.deepEqual(translated.plugins, [{ id: 'web' }]);
});

test('a request without web search is passed through untouched', () => {
  const req = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f' } }],
  };
  const translated = translateWebSearch(req);
  assert.equal(translated.plugins, undefined);
  assert.deepEqual(translated.tools, req.tools);
});

/**
 * The server tool lets the model write its own search query with the thread in
 * view; the plugin searches the last message alone and can answer a follow-up
 * with results about an unrelated subject. So the tool goes out as it came in.
 */
test('web search is sent as the server tool, untranslated', async () => {
  const seen: ChatCompletionRequest[] = [];
  const server = await startTestServer(async (req, res) => {
    seen.push(JSON.parse(await readBody(req)) as ChatCompletionRequest);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"ok","object":"chat.completion","model":"m","choices":[]}');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    await provider.chatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'openrouter:web_search', parameters: { engine: 'auto', max_uses: 1, max_results: 3 } }],
    });

    assert.equal(seen.length, 1, 'a request OpenRouter accepts must not be sent twice');
    assert.deepEqual(seen[0]?.tools, [
      { type: 'openrouter:web_search', parameters: { engine: 'auto', max_uses: 1, max_results: 3 } },
    ]);
    assert.equal((seen[0] as { plugins?: unknown }).plugins, undefined);
  } finally {
    await server.close();
  }
});

test('a refused web-search tool is retried as the plugin', async () => {
  const seen: ChatCompletionRequest[] = [];
  const server = await startTestServer(async (req, res) => {
    seen.push(JSON.parse(await readBody(req)) as ChatCompletionRequest);
    if (seen.length === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"rate limited","code":429}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"ok","object":"chat.completion","model":"m","choices":[]}');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    const result = await provider.chatCompletion({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 3 } }],
    });

    assert.equal(result.id, 'ok');
    assert.equal(seen.length, 2);
    assert.deepEqual((seen[1] as { plugins?: unknown }).plugins, [{ id: 'web', engine: 'exa', max_results: 3 }]);
    assert.equal(seen[1]?.tools, undefined);
  } finally {
    await server.close();
  }
});

test('a failure that is not the tool being refused is not retried', async () => {
  let requests = 0;
  const server = await startTestServer((_req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"upstream exploded"}}');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    await assert.rejects(
      provider.chatCompletion({
        model: 'm',
        messages: [],
        tools: [{ type: 'openrouter:web_search', parameters: {} }],
      }),
      /upstream exploded/,
    );
    assert.equal(requests, 1);
  } finally {
    await server.close();
  }
});

test('a refused tool is retried as the plugin mid-stream too', async () => {
  const seen: ChatCompletionRequest[] = [];
  const server = await startTestServer(async (req, res) => {
    seen.push(JSON.parse(await readBody(req)) as ChatCompletionRequest);
    if (seen.length === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"rate limited","code":429}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"id":"1","object":"chunk","created":0,"model":"m","choices":[]}\n\ndata: [DONE]\n\n');
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    const chunks = [];
    for await (const chunk of provider.chatCompletionStream({
      model: 'm',
      messages: [],
      tools: [{ type: 'openrouter:web_search', parameters: { engine: 'auto' } }],
    })) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 1);
    assert.equal(seen.length, 2);
    assert.deepEqual((seen[1] as { plugins?: unknown }).plugins, [{ id: 'web' }]);
    assert.equal(seen[1]?.stream_options?.include_usage, true, 'the fallback still needs usage');
  } finally {
    await server.close();
  }
});

/**
 * A stream that has already delivered content cannot be replayed: the client
 * would receive the opening of one answer followed by the whole of another.
 */
test('a stream that has begun is not retried', async () => {
  let requests = 0;
  const server = await startTestServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: {"id":"1","object":"chunk","created":0,"model":"m","choices":[]}\n\n' +
        'data: {"error":{"message":"died after the first chunk","code":429}}\n\n',
    );
  });

  try {
    const provider = new OpenRouterProvider({ apiKey: 'test-key', baseUrl: server.url });
    const chunks = [];
    await assert.rejects(async () => {
      for await (const chunk of provider.chatCompletionStream({
        model: 'm',
        messages: [],
        tools: [{ type: 'openrouter:web_search', parameters: {} }],
      })) {
        chunks.push(chunk);
      }
    }, /died after the first chunk/);

    assert.equal(chunks.length, 1);
    assert.equal(requests, 1);
  } finally {
    await server.close();
  }
});
