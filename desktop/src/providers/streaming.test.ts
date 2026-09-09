import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamChunk } from './streaming.js';
import { OpenAiProvider } from './openai.js';
import { startTestServer } from '../test-support/server.js';
import type { Choice } from './types.js';

test('intermediate choice serializes finish_reason as null', () => {
  const intermediate: Choice = { index: 0, delta: {}, finish_reason: null };
  assert.match(JSON.stringify(intermediate), /"finish_reason":null/);

  const terminal: Choice = { index: 0, delta: {}, finish_reason: 'stop' };
  assert.match(JSON.stringify(terminal), /"finish_reason":"stop"/);
});

test('parseStreamChunk surfaces an error envelope', () => {
  assert.throws(
    () => parseStreamChunk('{"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}'),
    /rate limit exceeded/,
  );

  const chunk = parseStreamChunk('{"id":"chatcmpl-1","object":"chat.completion.chunk"}');
  assert.equal(chunk.id, 'chatcmpl-1');
});

test('parseStreamChunk keeps reasoning and cost', () => {
  const chunk = parseStreamChunk(
    '{"choices":[{"index":0,"delta":{"reasoning":"thinking"}}],"usage":{"cost":0.001}}',
  );
  assert.equal(chunk.choices[0]?.delta?.reasoning, 'thinking');
  assert.equal(chunk.usage?.cost, 0.001);
});

test('a mid-stream error envelope surfaces and the stream does not complete normally', async () => {
  const sse = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"partial"}}]}',
    '',
    'data: {"error":{"message":"upstream overloaded","type":"server_error"}}',
    '',
  ].join('\n');

  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse);
  });

  try {
    const provider = new OpenAiProvider({ apiKey: 'test-key', baseUrl: server.url });
    const received: string[] = [];
    let streamErr: unknown;

    try {
      for await (const chunk of provider.chatCompletionStream({ model: 'gpt-4', messages: [] })) {
        received.push(chunk.choices[0]?.delta?.content ?? '');
      }
      // reaching here means the stream ended cleanly, which the envelope forbids
      assert.fail('mid-stream error envelope must surface as a stream error');
    } catch (err) {
      streamErr = err;
    }

    assert.deepEqual(received, ['partial']);
    assert.match(String(streamErr), /upstream overloaded/);
  } finally {
    await server.close();
  }
});
