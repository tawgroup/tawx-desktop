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
  // OpenRouter's agentic web_search tool answers 429 for requests the plugin
  // serves, so the request is rewritten on the way out.
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
