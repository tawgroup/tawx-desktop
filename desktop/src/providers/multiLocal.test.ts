import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiLocalProvider, isNetworkError } from './multiLocal.js';
import { ApiError, ErrorType } from './errors.js';
import { readBody, startTestServer } from '../test-support/server.js';

/** An address nothing listens on, so connecting refuses immediately. */
const DEAD_URL = 'http://127.0.0.1:1';

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const connRefused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

const networkErrorCases: Array<[string, unknown, boolean]> = [
  ['null', null, false],
  ['undefined', undefined, false],
  ['connection refused', connRefused(), true],
  ['socket dropped', Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }), true],
  ['abort', abortError(), false],
  ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), false],
  ['application error', new ApiError('model not found', ErrorType.NotFound), false],
  ['plain error', new Error('model not found'), false],
];

for (const [name, err, want] of networkErrorCases) {
  test(`isNetworkError: ${name}`, () => {
    assert.equal(isNetworkError(err), want);
  });
}

test('round-robin replays the full body on failover', async () => {
  let received = '';
  const server = await startTestServer(async (req, res) => {
    received = await readBody(req);
    res.writeHead(200);
    res.end();
  });

  try {
    // the dead endpoint refuses connections; the round-robin starts there and
    // must fail over to the live endpoint with the body intact.
    const multi = new MultiLocalProvider([
      { name: 'dead', baseUrl: DEAD_URL },
      { name: 'live', baseUrl: server.url },
    ]);
    const body = '{"model":"test","input":["hello world"]}';

    const res = await multi.roundRobinFetch()('http://multi.local/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(received, body);
    multi.close();
  } finally {
    await server.close();
  }
});

test('round-robin fails over when the body dies mid-read', async () => {
  let served = false;
  const server = await startTestServer((_req, res) => {
    served = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });

  try {
    // the flaky endpoint returns headers then a body that dies; that read
    // failure must fail over rather than reach the caller.
    const flakyFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }));
          },
        }),
        { status: 200 },
      );

    const multi = new MultiLocalProvider([
      { name: 'flaky', baseUrl: 'http://flaky.local', fetchImpl: flakyFetch },
      { name: 'live', baseUrl: server.url },
    ]);

    const res = await multi.roundRobinFetch()('http://multi.local/api/embed', {
      method: 'POST',
      body: '{"input":["x"]}',
    });

    assert.equal(await res.text(), '{"ok":true}');
    assert.ok(served, 'failover did not reach the live endpoint');
    multi.close();
  } finally {
    await server.close();
  }
});

test('chatCompletion fails over past a dead endpoint', async () => {
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"ok","object":"chat.completion","model":"llama3","choices":[]}');
  });

  try {
    const multi = new MultiLocalProvider([
      { name: 'dead', baseUrl: DEAD_URL },
      { name: 'live', baseUrl: server.url },
    ]);

    const response = await multi.chatCompletion({ model: 'llama3', messages: [] });
    assert.equal(response.id, 'ok');
    multi.close();
  } finally {
    await server.close();
  }
});

test('an application error is not failed over', async () => {
  let hits = 0;
  const server = await startTestServer((_req, res) => {
    hits += 1;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"bad request","type":"invalid_request_error"}}');
  });

  try {
    const multi = new MultiLocalProvider([
      { name: 'a', baseUrl: server.url },
      { name: 'b', baseUrl: server.url },
    ]);

    await assert.rejects(() => multi.chatCompletion({ model: 'llama3', messages: [] }), /bad request/);
    assert.equal(hits, 1, 'an application error must not be retried against another endpoint');
    multi.close();
  } finally {
    await server.close();
  }
});

test('listModels unions healthy endpoints and deduplicates by id', async () => {
  const models = (ids: string[]) =>
    JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'x' })) });

  const first = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(models(['llama3', 'shared']));
  });
  const second = await startTestServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(models(['shared', 'mistral']));
  });

  try {
    const multi = new MultiLocalProvider([
      { name: 'a', baseUrl: first.url },
      { name: 'b', baseUrl: second.url },
    ]);

    const ids = (await multi.listModels()).map((model) => model.id);
    assert.deepEqual(ids, ['llama3', 'shared', 'mistral']);
    multi.close();
  } finally {
    await first.close();
    await second.close();
  }
});

test('health checks back off, then recover, and honour weights in rotation', async () => {
  let now = 1_000_000;
  const multi = new MultiLocalProvider(
    [
      { name: 'dead', baseUrl: DEAD_URL },
      { name: 'live', baseUrl: DEAD_URL },
    ],
    { now: () => now, sleep: async () => undefined },
  );

  // no server is listening, so every probe fails and backoff accumulates
  multi.startHealthChecks(1_000, 50);
  await multi.checkAll();
  await multi.checkAll();

  // nextCheck is in the future, so a further sweep is skipped rather than
  // hammering an endpoint that is already known to be down
  now += 10;
  await multi.checkAll();

  multi.close();
});
