import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, streamCompletion, fetchCompletion } from '../src/lib/api.ts';
import type { Provider } from '../src/types.ts';

const provider = {
  id: 'gateway',
  name: 'LLM Gateway',
  kind: 'gateway',
  baseUrl: '/v1',
  authKind: 'none',
  apiKey: '',
  enabled: true,
  model: 'auto',
  discoveredModels: ['auto'],
  visionModels: [],
  connectionStatus: 'connected',
} as unknown as Provider;

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('an error frame mid-stream is raised, not swallowed', async () => {
  // A provider that fails after headers are sent reports it in-band under a
  // 200. Ignoring the frame used to end the turn with an empty reply and no
  // explanation — the user saw a blank bubble.
  const frames = [JSON.stringify({ error: { message: 'Provider returned error', type: 'server_error', code: 429 } })];
  await withFetch(
    (async () => sseResponse(frames)) as typeof fetch,
    async () => {
      await assert.rejects(
        () => streamCompletion({ provider, model: 'auto', messages: [{ role: 'user', content: 'hi' }], onToken: () => {} }),
        (err: unknown) =>
          err instanceof ApiError && err.message === 'Provider returned error' && err.status === 429,
      );
    },
  );
});

test('tokens received before the error frame do not mask it', async () => {
  const frames = [
    JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }),
    JSON.stringify({ error: { message: 'upstream died' } }),
  ];
  const tokens: string[] = [];
  await withFetch(
    (async () => sseResponse(frames)) as typeof fetch,
    async () => {
      await assert.rejects(
        () =>
          streamCompletion({
            provider,
            model: 'auto',
            messages: [{ role: 'user', content: 'hi' }],
            onToken: (t) => tokens.push(t),
          }),
        (err: unknown) => err instanceof ApiError && err.message === 'upstream died',
      );
    },
  );
  assert.deepEqual(tokens, ['partial'], 'the tokens that did arrive still reach the caller');
});

test('a malformed frame is still ignored', async () => {
  const frames = ['{not json', JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]'];
  await withFetch(
    (async () => sseResponse(frames)) as typeof fetch,
    async () => {
      const full = await streamCompletion({
        provider,
        model: 'auto',
        messages: [{ role: 'user', content: 'hi' }],
        onToken: () => {},
      });
      assert.equal(full, 'ok');
    },
  );
});

test('a non-streaming 200 carrying an error is raised too', async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ error: { message: 'no credits', code: 402 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    async () => {
      await assert.rejects(
        () => fetchCompletion({ provider, model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
        (err: unknown) => err instanceof ApiError && err.status === 402,
      );
    },
  );
});
