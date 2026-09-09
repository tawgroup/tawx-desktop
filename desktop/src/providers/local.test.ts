import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalProvider } from './local.js';
import { ApiError, ErrorType, statusCodeForError } from './errors.js';
import { startTestServer } from '../test-support/server.js';

/**
 * Exercised through the public surface rather than by reaching into
 * parseError, which the Go test could call directly as a package sibling.
 */
async function errorFrom(statusCode: number, body: string): Promise<ApiError> {
  const server = await startTestServer((_req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(body);
  });

  try {
    const provider = new LocalProvider({ baseUrl: server.url });
    await provider.chatCompletion({ model: 'llama3', messages: [] });
    assert.fail('expected the backend error to surface');
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    return err;
  } finally {
    await server.close();
  }
}

// the local provider fronts any OpenAI-compatible backend (vLLM, SGLang,
// llama-server) as well as ollama's native shape, so error parsing has to read
// both envelopes and must never hand an unrecognized body to the client.
const cases: Array<{
  name: string;
  statusCode: number;
  body: string;
  wantType: string;
  wantStatus: number;
  wantMsg?: string;
}> = [
  {
    name: 'openai envelope keeps its type and status',
    statusCode: 400,
    body: '{"error":{"message":"bad request","type":"invalid_request_error"}}',
    wantType: ErrorType.InvalidRequest,
    wantStatus: 400,
    wantMsg: 'bad request',
  },
  {
    name: 'openai envelope not-found',
    statusCode: 404,
    body: '{"error":{"message":"unknown model","type":"not_found_error"}}',
    wantType: ErrorType.NotFound,
    wantStatus: 404,
    wantMsg: 'unknown model',
  },
  {
    name: 'ollama string form stays a server error',
    statusCode: 500,
    body: '{"error":"model requires more system memory"}',
    wantType: ErrorType.Server,
    wantStatus: 500,
    wantMsg: 'model requires more system memory',
  },
  {
    name: 'unrecognized body falls back on status alone',
    statusCode: 502,
    body: '<html><body>nginx: upstream unavailable</body></html>',
    wantType: ErrorType.Server,
    wantStatus: 500,
  },
  {
    name: 'unrecognized 404',
    statusCode: 404,
    body: 'not json',
    wantType: ErrorType.NotFound,
    wantStatus: 404,
    wantMsg: 'model not found',
  },
  {
    name: 'unrecognized 503',
    statusCode: 503,
    body: 'not json',
    wantType: ErrorType.ServiceUnavailable,
    wantStatus: 503,
    wantMsg: 'service unavailable',
  },
];

for (const testCase of cases) {
  test(`local parseError: ${testCase.name}`, async () => {
    const err = await errorFrom(testCase.statusCode, testCase.body);
    assert.equal(err.type, testCase.wantType);
    assert.equal(statusCodeForError(err.type), testCase.wantStatus);
    if (testCase.wantMsg) assert.equal(err.message, testCase.wantMsg);
  });
}

// an unrecognized body belongs to an arbitrary backend reached over an
// operator-configured transport; its contents must not reach the client.
test('local parseError does not embed an unrecognized body', async () => {
  const err = await errorFrom(502, '<html>proxy debug: internal-host-9 token=s3cret</html>');
  for (const leak of ['internal-host-9', 's3cret', 'proxy debug']) {
    assert.ok(!err.message.includes(leak), `leaked upstream body content ${leak}: ${err.message}`);
  }
});

test('listModels falls back to ollama /api/tags when /v1/models is absent', async () => {
  const server = await startTestServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"models":[{"name":"llama3:8b","modified_at":"2024-01-01T00:00:00Z"}]}');
  });

  try {
    const models = await new LocalProvider({ baseUrl: server.url }).listModels();
    assert.deepEqual(models, [{ id: 'llama3:8b', object: 'model', created: 0, owned_by: 'ollama' }]);
  } finally {
    await server.close();
  }
});
