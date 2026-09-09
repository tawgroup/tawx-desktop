/** Ported from providers/anthropic_test.go. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from './errors.js';
import { AnthropicProvider, type AnthropicContentBlock, type AnthropicResponse } from './anthropic.js';
import type { ChatCompletionRequest, Message, StreamChunk, Tool, ToolCall } from './types.js';

function newAnthropic(): AnthropicProvider {
  return new AnthropicProvider({ apiKey: 'test-key', baseUrl: '' });
}

describe('translateRequest', () => {
  const cases: {
    name: string;
    req: ChatCompletionRequest;
    wantSys: string | undefined;
    wantMsgs: number;
    wantMax: number;
  }[] = [
    {
      name: 'basic request without system',
      req: {
        model: 'claude-3-opus',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      wantSys: undefined,
      wantMsgs: 1,
      wantMax: 4096, // default
    },
    {
      name: 'request with system message',
      req: {
        model: 'claude-3-opus',
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
      },
      wantSys: 'You are helpful',
      wantMsgs: 1, // system extracted, only user message remains
      wantMax: 4096,
    },
    {
      name: 'request with max_tokens',
      req: {
        model: 'claude-3-opus',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'Hello' }],
      },
      wantSys: undefined,
      wantMsgs: 1,
      wantMax: 1000,
    },
  ];

  for (const tt of cases) {
    test(tt.name, () => {
      const a = newAnthropic();
      const result = a.translateRequest(tt.req);
      assert.equal(result.system, tt.wantSys);
      assert.equal(result.messages.length, tt.wantMsgs);
      assert.equal(result.max_tokens, tt.wantMax);
    });
  }
});

describe('translateStopReason', () => {
  const cases: { input: string; want: string }[] = [
    { input: 'end_turn', want: 'stop' },
    { input: 'max_tokens', want: 'length' },
    { input: 'stop_sequence', want: 'stop' },
    { input: 'tool_use', want: 'tool_calls' },
    { input: 'unknown', want: 'unknown' },
  ];

  for (const tt of cases) {
    test(tt.input, () => {
      const a = newAnthropic();
      assert.equal(a.translateStopReason(tt.input), tt.want);
    });
  }
});

describe('extractContent', () => {
  const cases: { name: string; content: unknown; want: string }[] = [
    { name: 'string content', content: 'Hello world', want: 'Hello world' },
    {
      name: 'array content with text',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
      want: 'Hello\nWorld',
    },
    { name: 'nil content', content: null, want: '' },
  ];

  for (const tt of cases) {
    test(tt.name, () => {
      const a = newAnthropic();
      assert.equal(a.extractContent(tt.content), tt.want);
    });
  }
});

test('translateResponse', () => {
  const a = newAnthropic();

  const resp: AnthropicResponse = {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world!' },
    ],
    model: 'claude-3-opus-20240229',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  const result = a.translateResponse(resp, 'claude-3-opus-20240229');

  assert.equal(result.id, 'msg_123');
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.choices.length, 1);

  const choice = result.choices[0]!;
  assert.equal(choice.finish_reason, 'stop');
  assert.ok(choice.message);
  assert.equal(choice.message!.role, 'assistant');

  // content should be joined
  assert.equal(typeof choice.message!.content, 'string');
  assert.equal(choice.message!.content, 'Hello world!');

  assert.ok(result.usage);
  assert.equal(result.usage!.prompt_tokens, 10);
  assert.equal(result.usage!.completion_tokens, 5);
  assert.equal(result.usage!.total_tokens, 15);
});

test('request JSON', () => {
  const a = newAnthropic();

  const req: ChatCompletionRequest = {
    model: 'claude-3-opus',
    max_tokens: 2000,
    temperature: 0.7,
    messages: [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
    ],
    stop: ['END'],
  };

  const result = a.translateRequest(req);

  // verify it marshals correctly
  const data = JSON.stringify(result);
  const parsed = JSON.parse(data) as Record<string, unknown>;

  assert.equal(parsed.model, 'claude-3-opus');
  assert.equal(parsed.max_tokens, 2000);
  assert.equal(parsed.system, 'You are helpful');
});

test('translateTools', () => {
  const a = newAnthropic();

  const tools: Tool[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
    { type: 'function', function: { name: 'no_params' } }, // no params -> default schema
    { type: 'retrieval', function: { name: 'skipme' } }, // non-function -> skipped
  ];

  const out = a.translateTools(tools);
  assert.ok(out);
  assert.equal(out!.length, 2);
  assert.equal(out![0]!.name, 'get_weather');
  assert.equal(out![0]!.description, 'Get weather');

  // nil params default to an object schema
  const schema = out![1]!.input_schema as Record<string, unknown>;
  assert.equal(schema.type, 'object');
  assert.ok('properties' in schema);
});

describe('translateToolChoice', () => {
  const cases: {
    name: string;
    input: unknown;
    wantType: string;
    wantName: string;
    wantDrop: boolean;
    wantNil: boolean;
  }[] = [
    { name: 'auto', input: 'auto', wantType: 'auto', wantName: '', wantDrop: false, wantNil: false },
    { name: 'required', input: 'required', wantType: 'any', wantName: '', wantDrop: false, wantNil: false },
    { name: 'none', input: 'none', wantType: '', wantName: '', wantDrop: true, wantNil: true },
    {
      name: 'named',
      input: { type: 'function', function: { name: 'get_weather' } },
      wantType: 'tool',
      wantName: 'get_weather',
      wantDrop: false,
      wantNil: false,
    },
    { name: 'unknown string', input: 'wat', wantType: '', wantName: '', wantDrop: false, wantNil: true },
    { name: 'nil', input: undefined, wantType: '', wantName: '', wantDrop: false, wantNil: true },
  ];

  for (const tt of cases) {
    test(tt.name, () => {
      const a = newAnthropic();
      const [choice, drop] = a.translateToolChoice(tt.input);
      assert.equal(drop, tt.wantDrop);
      if (tt.wantNil) {
        assert.equal(choice, undefined);
        return;
      }
      assert.ok(choice);
      assert.equal(choice!.type, tt.wantType);
      assert.equal(choice!.name ?? '', tt.wantName);
    });
  }
});

describe('translateRequest with tools', () => {
  const a = newAnthropic();
  const tools: Tool[] = [
    { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
  ];

  test('auto', () => {
    const req: ChatCompletionRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      tool_choice: 'auto',
    };
    const ar = a.translateRequest(req);
    assert.ok(ar.tools);
    assert.equal(ar.tools!.length, 1);
    assert.equal(ar.tools![0]!.name, 'get_weather');
    assert.ok(ar.tool_choice);
    assert.equal(ar.tool_choice!.type, 'auto');

    // verify the anthropic wire shape: tools[].input_schema and the
    // tool_choice object (the two translations the original bug dropped).
    const parsed = JSON.parse(JSON.stringify(ar)) as Record<string, unknown>;
    const toolsJSON = parsed.tools as Record<string, unknown>[];
    assert.equal(toolsJSON.length, 1);
    assert.ok('input_schema' in toolsJSON[0]!);
    const tc = parsed.tool_choice as Record<string, unknown>;
    assert.equal(tc.type, 'auto');
  });

  test('none drops tools', () => {
    const req: ChatCompletionRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'weather?' }],
      tools,
      tool_choice: 'none',
    };
    const ar = a.translateRequest(req);
    assert.equal(ar.tools, undefined);
    assert.equal(ar.tool_choice, undefined);
  });
});

describe('convertAssistantMessage tool calls', () => {
  const a = newAnthropic();

  test('tool calls only', () => {
    const msg: Message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
      ],
    };
    const am = a.convertAssistantMessage(msg);
    assert.ok(Array.isArray(am.content));
    const blocks = am.content as AnthropicContentBlock[];
    assert.equal(blocks.length, 1);
    const b = blocks[0]!;
    assert.equal(b.type, 'tool_use');
    assert.equal(b.id, 'call_1');
    assert.equal(b.name, 'get_weather');
    const input = b.input as Record<string, unknown>;
    assert.equal(input.city, 'NYC');
  });

  test('mixed text and tool', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'let me check',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
    };
    const am = a.convertAssistantMessage(msg);
    const blocks = am.content as AnthropicContentBlock[];
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.type, 'text');
    assert.equal(blocks[0]!.text, 'let me check');
    assert.equal(blocks[1]!.type, 'tool_use');
  });
});

test('convertToolResults (coalescing)', () => {
  const a = newAnthropic();

  const req: ChatCompletionRequest = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
          { id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'sunny' },
      { role: 'tool', tool_call_id: 'call_b', content: 'noon' },
      { role: 'user', content: 'thanks' },
    ],
  };

  const ar = a.translateRequest(req);

  // expected: user(weather?), assistant(2 tool_use), user(2 tool_result), user(thanks)
  assert.equal(ar.messages.length, 4);

  assert.equal(ar.messages[2]!.role, 'user');
  assert.ok(Array.isArray(ar.messages[2]!.content));
  const results = ar.messages[2]!.content as AnthropicContentBlock[];
  assert.equal(results.length, 2);
  assert.equal(results[0]!.type, 'tool_result');
  assert.equal(results[0]!.tool_use_id, 'call_a');
  assert.equal(results[0]!.content, 'sunny');
  assert.equal(results[1]!.tool_use_id, 'call_b');
  assert.equal(results[1]!.content, 'noon');

  assert.equal(ar.messages[3]!.content, 'thanks');
});

describe('translateResponse tool use', () => {
  const a = newAnthropic();

  test('tool use only', () => {
    const resp: AnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } }],
      model: '',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const result = a.translateResponse(resp, 'claude-sonnet-4-6');
    const choice = result.choices[0]!;
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message!.content, null);
    assert.equal(choice.message!.tool_calls!.length, 1);
    const tc: ToolCall = choice.message!.tool_calls![0]!;
    assert.equal(tc.id, 'toolu_1');
    assert.equal(tc.type, 'function');
    assert.equal(tc.function.name, 'get_weather');
    assert.equal(tc.function.arguments, '{"city":"NYC"}');
  });

  test('mixed text and tool use', () => {
    const resp: AnthropicResponse = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking now' },
        { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: {} },
      ],
      model: '',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const result = a.translateResponse(resp, 'claude-sonnet-4-6');
    const msg = result.choices[0]!.message!;
    assert.equal(msg.content, 'checking now');
    assert.equal(msg.tool_calls!.length, 1);
  });
});

test('stream tool calls', async () => {
  const a = newAnthropic();

  const sse = [
    `data: {"type":"message_start","message":{"id":"msg_1"}}`,
    ``,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}`,
    ``,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}`,
    ``,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"NYC\\"}"}}`,
    ``,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    ``,
    `data: {"type":"message_stop"}`,
    ``,
    // a trailing event after message_stop: if the generator didn't `return`
    // on message_stop (the "Done" equivalent), this would produce a 5th chunk.
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"should not appear"}}`,
    ``,
  ].join('\n');

  const body = new Response(sse).body!;
  const chunks: StreamChunk[] = [];
  for await (const chunk of a.readSSEStream(body, 'claude-sonnet-4-6')) {
    chunks.push(chunk);
  }
  // reaching here without throwing is the "Done" equivalent (see readSSEStream doc comment).

  assert.equal(chunks.length, 4);

  // opening tool chunk: index + id + type + name, empty arguments
  const open = chunks[0]!.choices[0]!.delta!.tool_calls!;
  assert.equal(open.length, 1);
  assert.equal(open[0]!.index, 0);
  assert.equal(open[0]!.id, 'toolu_1');
  assert.equal(open[0]!.type, 'function');
  assert.equal(open[0]!.function.name, 'get_weather');
  assert.equal(open[0]!.function.arguments ?? '', '');

  // argument fragments share the index, leak no other fields, concat to valid JSON
  let args = '';
  for (const c of chunks.slice(1, 3)) {
    const tc = c.choices[0]!.delta!.tool_calls!;
    assert.equal(tc.length, 1);
    assert.equal(tc[0]!.index, 0);
    assert.equal(tc[0]!.id ?? '', '');
    assert.equal(tc[0]!.type ?? '', '');
    assert.equal(tc[0]!.function.name ?? '', '');
    args += tc[0]!.function.arguments ?? '';
  }
  assert.equal(args, '{"city":"NYC"}');
  assert.doesNotThrow(() => JSON.parse(args));

  // final chunk carries finish_reason
  assert.equal(chunks[3]!.choices[0]!.finish_reason, 'tool_calls');
});

test('stream error event', async () => {
  const a = newAnthropic();

  const sse = [
    `data: {"type":"message_start","message":{"id":"msg_1"}}`,
    ``,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}`,
    ``,
    `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
    ``,
  ].join('\n');

  const body = new Response(sse).body!;
  const chunks: StreamChunk[] = [];

  await assert.rejects(
    async () => {
      for await (const chunk of a.readSSEStream(body, 'claude-sonnet-4-6')) {
        chunks.push(chunk);
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof ApiError, 'mid-stream error event must surface as a thrown ApiError');
      assert.ok((err as ApiError).message.includes('Overloaded'), 'stream error must carry the upstream message');
      return true;
    },
  );
});

test('stream tool call index mapping', async () => {
  const a = newAnthropic();

  // text block at anthropic index 0, tool_use at anthropic index 1; the OpenAI
  // tool_call index must still be 0 (it counts only tool calls).
  const sse = [
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    ``,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
    ``,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"f"}}`,
    ``,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}`,
    ``,
    `data: {"type":"message_stop"}`,
    ``,
  ].join('\n');

  const body = new Response(sse).body!;

  let textContent = '';
  let toolIdx: number | undefined;
  for await (const chunk of a.readSSEStream(body, 'm')) {
    const d = chunk.choices[0]!.delta!;
    if (d.content) textContent += d.content;
    if (d.tool_calls && d.tool_calls.length > 0 && d.tool_calls[0]!.index !== undefined) {
      toolIdx = d.tool_calls[0]!.index;
    }
  }

  assert.equal(textContent, 'hi');
  assert.equal(toolIdx, 0);
});

test('stream fragment wire shape', () => {
  // a streaming argument fragment should serialize as
  // {"index":N,"function":{"arguments":"..."}} with no empty id/type/name.
  const tc: ToolCall = { index: 0, function: { arguments: '{"a":1}' } };
  const s = JSON.stringify(tc);
  assert.ok(!s.includes('"id"'));
  assert.ok(!s.includes('"type"'));
  assert.ok(!s.includes('"name"'));
});
