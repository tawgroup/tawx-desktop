import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { BlobStore, CursorProvider, buildRunRequest } from './cursor.js';
import { ApiError } from './errors.js';
import {
  concat,
  decodeMessage,
  encodeBytesField,
  encodeFrame,
  encodeMessageField,
  encodeStringField,
  encodeVarintField,
  messageField,
  numberField,
  readFrames,
  stringField,
} from './cursorWire.js';
import type { ChatCompletionRequest, StreamChunk } from './types.js';

// wire format

test('varints round-trip past the single-byte boundary', () => {
  const encoded = concat(encodeVarintField(1, 300), encodeVarintField(2, 1));
  const fields = decodeMessage(encoded);
  assert.equal(numberField(fields, 1), 300);
  assert.equal(numberField(fields, 2), 1);
});

test('proto3 drops zero-valued scalars but keeps empty messages', () => {
  // A zero varint is indistinguishable from an absent field on the wire, while
  // an empty nested message is how a no-field oneof arm signals its presence.
  assert.equal(encodeVarintField(1, 0).length, 0);
  assert.equal(encodeStringField(1, '').length, 0);
  assert.equal(encodeMessageField(2, new Uint8Array(0)).length, 2);
});

test('nested messages decode to their own fields', () => {
  const inner = concat(encodeStringField(1, 'hello'), encodeVarintField(2, 7));
  const outer = encodeMessageField(3, inner);
  const decoded = messageField(decodeMessage(outer), 3);
  assert.ok(decoded);
  assert.equal(stringField(decoded, 1), 'hello');
  assert.equal(numberField(decoded, 2), 7);
});

test('a long string survives a multi-byte length prefix', () => {
  const long = 'x'.repeat(5000);
  assert.equal(stringField(decodeMessage(encodeStringField(1, long)), 1), long);
});

test('frames split across chunk boundaries are held back until whole', () => {
  const stream = concat(encodeFrame(encodeStringField(1, 'one')), encodeFrame(encodeStringField(1, 'two')));
  const firstHalf = stream.subarray(0, 7);
  const secondHalf = stream.subarray(7);

  const partial = readFrames(firstHalf);
  assert.equal(partial.frames.length, 0, 'an incomplete frame must not be emitted');

  const rest = readFrames(concat(partial.rest, secondHalf));
  assert.equal(rest.frames.length, 2);
  assert.equal(rest.rest.length, 0);
  assert.deepEqual(
    rest.frames.map((f) => stringField(decodeMessage(f.payload), 1)),
    ['one', 'two'],
  );
});

// request construction

const request = (messages: ChatCompletionRequest['messages']): ChatCompletionRequest => ({
  model: 'composer-2.5',
  messages,
});

/** Unwraps AgentClientMessage{runRequest} down to the fields under test. */
function runRequestOf(req: ChatCompletionRequest, blobs: BlobStore) {
  const decoded = messageField(decodeMessage(buildRunRequest(req, blobs)), 1);
  assert.ok(decoded, 'runRequest must be field 1 of AgentClientMessage');
  return decoded;
}

test('the trailing user message becomes the action, not a turn', () => {
  const blobs = new BlobStore();
  const run = runRequestOf(request([{ role: 'user', content: 'hi there' }]), blobs);

  const action = messageField(run, 2);
  assert.ok(action);
  const userMessageAction = messageField(action, 1);
  assert.ok(userMessageAction, 'a user prompt must send userMessageAction');
  const userMessage = messageField(userMessageAction, 1);
  assert.ok(userMessage);
  assert.equal(stringField(userMessage, 1), 'hi there');

  const state = messageField(run, 1);
  assert.ok(state);
  assert.equal(state.filter((f) => f.no === 8).length, 0, 'no prior turns to send');
});

test('system messages become root prompt blobs the store can answer for', () => {
  const blobs = new BlobStore();
  const run = runRequestOf(
    request([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]),
    blobs,
  );

  const state = messageField(run, 1);
  assert.ok(state);
  const roots = state.filter((f) => f.no === 1).map((f) => f.value as Uint8Array);
  assert.equal(roots.length, 1);

  const stored = blobs.get(roots[0] as Uint8Array);
  assert.ok(stored, 'a referenced blob must be retrievable when the server asks');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(stored)), {
    role: 'system',
    content: 'be terse',
  });
});

test('a blob id is the sha256 of its content', () => {
  const blobs = new BlobStore();
  const bytes = new TextEncoder().encode('payload');
  const id = blobs.put(bytes);
  assert.equal(Buffer.from(id).toString('hex'), createHash('sha256').update(bytes).digest('hex'));
});

test('earlier exchanges become turns that reference their parts by hash', () => {
  const blobs = new BlobStore();
  const run = runRequestOf(
    request([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]),
    blobs,
  );

  const state = messageField(run, 1);
  assert.ok(state);
  const turns = state.filter((f) => f.no === 8).map((f) => f.value as Uint8Array);
  assert.equal(turns.length, 1, 'only the completed exchange is a turn');

  const turnBlob = blobs.get(turns[0] as Uint8Array);
  assert.ok(turnBlob);
  const agentTurn = messageField(decodeMessage(turnBlob), 1);
  assert.ok(agentTurn, 'a turn must be an agentConversationTurn');

  const userBlob = blobs.get(agentTurn.find((f) => f.no === 1)?.value as Uint8Array);
  assert.ok(userBlob);
  assert.equal(stringField(decodeMessage(userBlob), 1), 'first');

  const stepBlob = blobs.get(agentTurn.find((f) => f.no === 2)?.value as Uint8Array);
  assert.ok(stepBlob);
  const assistantStep = messageField(decodeMessage(stepBlob), 1);
  assert.ok(assistantStep, 'an assistant reply is step variant 1');
  assert.equal(stringField(assistantStep, 1), 'answer');
});

test('a conversation with no trailing user message resumes instead of prompting', () => {
  const blobs = new BlobStore();
  const run = runRequestOf(
    request([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
    ]),
    blobs,
  );
  const action = messageField(run, 2);
  assert.ok(action);
  assert.equal(messageField(action, 1), undefined, 'no userMessageAction');
  assert.ok(action.some((f) => f.no === 2), 'resumeAction must be present though empty');
});

test('multi-part content is flattened to its text', () => {
  const blobs = new BlobStore();
  const run = runRequestOf(
    request([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          { type: 'text', text: 'here' },
        ],
      },
    ]),
    blobs,
  );
  const userMessage = messageField(messageField(messageField(run, 2) ?? [], 1) ?? [], 1);
  assert.ok(userMessage);
  assert.equal(stringField(userMessage, 1), 'look\nhere');
});

// streaming against a scripted server

/** Minimal stand-in for an http2 session that replays a scripted exchange. */
class FakeRequest extends EventEmitter {
  written: Uint8Array[] = [];
  writableEnded = false;
  write(chunk: Buffer): boolean {
    this.written.push(new Uint8Array(chunk));
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  destroy(): void {}
  /** Every client frame sent so far, decoded as AgentClientMessage. */
  clientMessages() {
    return readFrames(concat(...this.written)).frames.map((f) => decodeMessage(f.payload));
  }
}

function fakeConnect(script: (req: FakeRequest) => void) {
  const request = new FakeRequest();
  const session = Object.assign(new EventEmitter(), {
    request: () => request,
    close: () => {},
  });
  return {
    request,
    connect: (() => {
      queueMicrotask(() => script(request));
      return session;
    }) as never,
  };
}

const serverFrame = (payload: Uint8Array) => Buffer.from(encodeFrame(payload));
const interactionUpdate = (payload: Uint8Array) => serverFrame(encodeMessageField(1, payload));

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('text and thinking deltas arrive as content and reasoning', async () => {
  const { connect } = fakeConnect((req) => {
    req.emit('response', { ':status': 200 });
    req.emit('data', interactionUpdate(encodeMessageField(4, encodeStringField(1, 'pondering'))));
    req.emit('data', interactionUpdate(encodeMessageField(1, encodeStringField(1, 'Hello'))));
    req.emit('data', interactionUpdate(encodeMessageField(1, encodeStringField(1, ' world'))));
    req.emit('data', interactionUpdate(encodeMessageField(8, encodeVarintField(1, 12))));
    req.emit('data', interactionUpdate(encodeMessageField(14, new Uint8Array(0))));
  });

  const provider = new CursorProvider({ apiKey: 'token', connectImpl: connect });
  const chunks = await collect(provider.chatCompletionStream(request([{ role: 'user', content: 'hi' }])));

  assert.deepEqual(
    chunks.flatMap((c) => (c.choices[0]?.delta?.content ? [c.choices[0].delta.content] : [])),
    ['Hello', ' world'],
  );
  assert.deepEqual(
    chunks.flatMap((c) => (c.choices[0]?.delta?.reasoning ? [c.choices[0].delta.reasoning] : [])),
    ['pondering'],
  );

  const last = chunks[chunks.length - 1];
  assert.equal(last?.choices[0]?.finish_reason, 'stop');
  assert.equal(last?.usage?.completion_tokens, 12);
});

test('a blob the server asks for is answered from the store', async () => {
  let asked: Uint8Array | undefined;
  const { request: fake, connect } = fakeConnect((req) => {
    req.emit('response', { ':status': 200 });
    // The first client frame is the run request; read the blob id it referenced.
    const run = messageField(req.clientMessages()[0] ?? [], 1);
    const state = messageField(run ?? [], 1);
    asked = state?.find((f) => f.no === 1)?.value as Uint8Array;
    req.emit('data', serverFrame(encodeMessageField(4, concat(
      encodeVarintField(1, 3),
      encodeMessageField(2, encodeBytesField(1, asked as Uint8Array)),
    ))));
    req.emit('data', interactionUpdate(encodeMessageField(14, new Uint8Array(0))));
  });

  const provider = new CursorProvider({ apiKey: 'token', connectImpl: connect });
  await collect(
    provider.chatCompletionStream(
      request([
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ]),
    ),
  );

  const reply = fake.clientMessages().find((m) => m.some((f) => f.no === 3));
  assert.ok(reply, 'the server must get a kvClientMessage back or it stalls');
  const kv = messageField(reply, 3);
  assert.ok(kv);
  assert.equal(numberField(kv, 1), 3, 'the reply must carry the query id');
  const getBlobResult = messageField(kv, 2);
  assert.ok(getBlobResult);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(getBlobResult.find((f) => f.no === 1)?.value as Uint8Array)),
    { role: 'system', content: 'be terse' },
  );
});

test('the workspace query is answered so the turn can start', async () => {
  const { request: fake, connect } = fakeConnect((req) => {
    req.emit('response', { ':status': 200 });
    req.emit('data', serverFrame(encodeMessageField(2, concat(
      encodeVarintField(1, 5),
      encodeStringField(15, 'exec-1'),
      encodeMessageField(10, new Uint8Array(0)),
    ))));
    req.emit('data', interactionUpdate(encodeMessageField(14, new Uint8Array(0))));
  });

  const provider = new CursorProvider({ apiKey: 'token', connectImpl: connect });
  await collect(provider.chatCompletionStream(request([{ role: 'user', content: 'hi' }])));

  const reply = fake.clientMessages().find((m) => m.some((f) => f.no === 2));
  assert.ok(reply, 'requestContext must be answered');
  const exec = messageField(reply, 2);
  assert.ok(exec);
  assert.equal(numberField(exec, 1), 5);
  assert.equal(stringField(exec, 15), 'exec-1', 'the execId must be echoed back');
  const result = messageField(exec, 10);
  assert.ok(messageField(result ?? [], 1), 'the result must be the success arm');
});

test('an end-of-stream error surfaces as an ApiError', async () => {
  const { connect } = fakeConnect((req) => {
    req.emit('response', { ':status': 200 });
    req.emit(
      'data',
      Buffer.from(
        encodeFrame(
          new TextEncoder().encode(JSON.stringify({ error: { code: 'resource_exhausted', message: 'quota' } })),
          0x02,
        ),
      ),
    );
  });

  const provider = new CursorProvider({ apiKey: 'token', connectImpl: connect });
  await assert.rejects(
    () => collect(provider.chatCompletionStream(request([{ role: 'user', content: 'hi' }]))),
    (err: unknown) => err instanceof ApiError && /quota/.test(err.message),
  );
});

test('a rejected token is an authentication error, not a server error', async () => {
  const { connect } = fakeConnect((req) => req.emit('response', { ':status': 401 }));
  const provider = new CursorProvider({ apiKey: 'stale', connectImpl: connect });
  await assert.rejects(
    () => collect(provider.chatCompletionStream(request([{ role: 'user', content: 'hi' }]))),
    (err: unknown) => err instanceof ApiError && err.type === 'authentication_error',
  );
});

test('a missing token fails before any connection is attempted', async () => {
  let connected = false;
  const provider = new CursorProvider({
    apiKey: '',
    connectImpl: (() => {
      connected = true;
      throw new Error('should not connect');
    }) as never,
  });
  await assert.rejects(
    () => collect(provider.chatCompletionStream(request([{ role: 'user', content: 'hi' }]))),
    ApiError,
  );
  assert.equal(connected, false);
});

test('the model catalog is read out of GetUsableModelsResponse', async () => {
  // GetUsableModelsResponse{ repeated ModelDetails models = 1 }, and a model's
  // id is its own field 1 — the rest of ModelDetails is presentation.
  const model = (id: string, displayName: string) =>
    encodeMessageField(1, concat(encodeStringField(1, id), encodeStringField(4, displayName)));
  const { connect } = fakeConnect((req) => {
    req.emit('response', { ':status': 200 });
    req.emit('data', Buffer.from(concat(model('composer-2.5', 'Composer 2.5'), model('kimi-k3-high', 'Kimi K3'))));
    req.emit('end');
  });

  const provider = new CursorProvider({ apiKey: 'token', connectImpl: connect });
  const models = await provider.listModels();
  assert.deepEqual(models.map((m) => m.id), ['composer-2.5', 'kimi-k3-high']);
  assert.equal(models[0]?.owned_by, 'cursor');
});
