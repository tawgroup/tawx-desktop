import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Provider } from '../providers/provider.js';
import { ProviderType, Router, type ProviderTypeValue } from '../providers/router.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Model,
  StreamChunk,
  Tool,
} from '../providers/types.js';
import { TaskRuntime } from './runtime.js';
import { TaskStore } from './store.js';
import type { AgentCapabilityRegistration } from './types.js';

const RUN_COMMAND: Tool = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Run a command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};

class TwoCommandProvider implements Provider {
  private iteration = 0;

  async chatCompletion(_request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    throw new Error('non-streaming completion is not used by this test');
  }

  async *chatCompletionStream(): AsyncIterable<StreamChunk> {
    const commands = ['npm test', 'rm -rf .'];
    const command = commands[this.iteration++];
    if (command) {
      yield chunk({
        tool_calls: [{
          index: 0,
          id: `call-${this.iteration}`,
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({ command, env: 'API_KEY=tool-secret-value' }),
          },
        }],
      });
      return;
    }
    yield chunk({ content: 'Finished.' });
  }

  async listModels(): Promise<Model[]> {
    return [];
  }
}

test('allow_session never approves a distinct command at the runtime boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-approval-'));
  const provider = new TwoCommandProvider();
  const providers = new Map<ProviderTypeValue, Provider>();
  providers.set(ProviderType.Local, provider);
  const approvalEvents = new EventEmitter();
  const runtime = new TaskRuntime({
    router: new Router(providers),
    store: new TaskStore(directory),
    registrations: [approvalCheckingTool(approvalEvents)],
  });

  try {
    const firstNotice = once(approvalEvents, 'approval');
    await runtime.initialize();
    const { id } = await runtime.dispatch({
      threadId: 'thread-1',
      mode: 'cowork',
      model: 'local-test-model',
      systemPrompt: 'PASSWORD=system-secret-value',
      messages: [{ role: 'user', content: 'TOKEN=user-secret-value Run both commands.' }],
      policy: 'ask',
      enabledTools: ['run_command'],
    });

    await firstNotice;
    const first = runtime.get(id)?.pendingApproval;
    assert.ok(first);
    assert.equal(approvalCommand(first.descriptor.input), 'npm test');

    const secondNotice = once(approvalEvents, 'approval');
    await runtime.approve(id, first.id, 'allow_session');
    await secondNotice;
    const second = runtime.get(id)?.pendingApproval;
    assert.ok(second);
    assert.notEqual(second.id, first.id);
    assert.equal(approvalCommand(second.descriptor.input), 'rm -rf .');
    await runtime.cancel(id);
    const persisted = await readFile(join(directory, `${id}.json`), 'utf8');
    assert.doesNotMatch(persisted, /system-secret-value|user-secret-value|tool-secret-value/);
    assert.match(persisted, /\[REDACTED\]/);
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

function approvalCheckingTool(approvalEvents: EventEmitter): AgentCapabilityRegistration {
  return {
    id: 'approval-test',
    capabilities: [{ name: 'run_command', description: 'Run a command.' }],
    create: (context) => ({
      definitions: [RUN_COMMAND],
      execute: async (_name, args) => {
        const pending = context.requestApproval({
          tool: 'run_command',
          detail: `Run ${String(args.command)}`,
          input: args,
        });
        approvalEvents.emit('approval');
        const decision = await pending;
        return decision === 'deny'
          ? { ok: false, output: null, error: 'denied' }
          : { ok: true, output: 'command completed' };
      },
    }),
  };
}


function approvalCommand(input: unknown): string {
  if (
    !input
    || typeof input !== 'object'
    || !('command' in input)
    || typeof input.command !== 'string'
  ) {
    assert.fail('approval input must contain a string command');
  }
  return input.command;
}

function chunk(delta: NonNullable<StreamChunk['choices'][number]['delta']>): StreamChunk {
  return {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'local-test-model',
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}
