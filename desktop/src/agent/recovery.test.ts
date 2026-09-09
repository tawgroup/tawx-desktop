import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { CODE_MODE_INSTRUCTION, TaskRuntime } from './runtime.js';
import { TaskStore } from './store.js';
import type { AgentCapabilityRegistration, PersistedTask } from './types.js';

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

class InspectingProvider implements Provider {
  constructor(private readonly events: EventEmitter) {}

  async chatCompletion(_request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    throw new Error('non-streaming completion is not used by this test');
  }

  async *chatCompletionStream(request: ChatCompletionRequest): AsyncIterable<StreamChunk> {
    this.events.emit('request', request);
    yield chunk({ content: 'Recovered safely.' });
  }

  async listModels(): Promise<Model[]> {
    return [];
  }
}

test('restart records unanswered tool calls as interrupted without re-executing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-recovery-'));
  const store = new TaskStore(directory);
  const events = new EventEmitter();
  let executions = 0;
  await store.save(recoveredTask('running', undefined));
  const runtime = createRuntime(store, new InspectingProvider(events), approvalRegistration(() => {
    executions += 1;
  }));

  try {
    const requested = once(events, 'request');
    await runtime.initialize();
    const [request] = (await requested) as [ChatCompletionRequest];
    assert.equal(executions, 0);
    const results = request.messages.filter((message) => message.role === 'tool');
    assert.deepEqual(results.map((message) => message.tool_call_id), ['call-1', 'call-2']);
    for (const result of results) assert.match(String(result.content), /interrupted by restart/);
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('approving a recovered multi-call turn executes the remaining calls in order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-approval-recovery-'));
  const store = new TaskStore(directory);
  const events = new EventEmitter();
  const commands: string[] = [];
  const task = recoveredTask('waiting_approval', {
    id: 'approval-1',
    toolCallId: 'call-1',
    toolName: 'run_command',
    descriptor: { tool: 'run_command', input: { command: 'npm test' } },
  });
  await store.save(task);
  const runtime = createRuntime(store, new InspectingProvider(events), approvalRegistration((command) => {
    commands.push(command);
    if (command === 'rm -rf .') events.emit('second-approval');
  }));

  try {
    await runtime.initialize();
    const secondApproval = once(events, 'second-approval');
    await runtime.approve(task.id, 'approval-1', 'allow_once');
    await secondApproval;
    assert.deepEqual(commands, ['npm test', 'rm -rf .']);
    const pending = runtime.get(task.id)?.pendingApproval;
    assert.ok(pending);
    assert.equal(pending.toolCallId, 'call-2');
    await runtime.cancel(task.id);
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('code mode requires a workspace and includes its instruction exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-code-mode-'));
  const events = new EventEmitter();
  const runtime = createRuntime(new TaskStore(directory), new InspectingProvider(events));

  try {
    await runtime.initialize();
    await assert.rejects(runtime.dispatch({
      threadId: 'code-no-workspace',
      mode: 'code',
      messages: [{ role: 'user', content: 'Change the code.' }],
      policy: 'ask',
      enabledTools: [],
    }), /requires a selected workspace/);

    const first = await runtime.dispatch({
      threadId: 'code-workspace',
      mode: 'code',
      model: 'local-test-model',
      messages: [{ role: 'user', content: 'Change the code.' }],
      systemPrompt: 'Be concise.',
      workspace: { path: directory, name: 'workspace' },
      policy: 'ask',
      enabledTools: [],
    });
    assert.equal(occurrences(runtime.get(first.id)?.systemPrompt ?? '', CODE_MODE_INSTRUCTION), 1);

    const second = await runtime.dispatch({
      threadId: 'code-prepared',
      mode: 'code',
      model: 'local-test-model',
      messages: [{ role: 'user', content: 'Change the code.' }],
      systemPrompt: `Be concise.\n\n${CODE_MODE_INSTRUCTION}\n\n${CODE_MODE_INSTRUCTION}`,
      workspace: { path: directory, name: 'workspace' },
      policy: 'ask',
      enabledTools: [],
    });
    assert.equal(occurrences(runtime.get(second.id)?.systemPrompt ?? '', CODE_MODE_INSTRUCTION), 1);
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

function createRuntime(
  store: TaskStore,
  provider: Provider,
  registration?: AgentCapabilityRegistration,
): TaskRuntime {
  const providers = new Map<ProviderTypeValue, Provider>();
  providers.set(ProviderType.Local, provider);
  return new TaskRuntime({
    router: new Router(providers),
    store,
    registrations: registration ? [registration] : [],
  });
}

function approvalRegistration(onExecute: (command: string) => void): AgentCapabilityRegistration {
  return {
    id: 'recovery-tool',
    capabilities: [{ name: 'run_command', description: 'Run a command.' }],
    create: (context) => ({
      definitions: [RUN_COMMAND],
      execute: async (_name, args) => {
        const command = String(args.command);
        const pending = context.requestApproval({
          tool: 'run_command',
          detail: `Run ${command}`,
          input: args,
        });
        onExecute(command);
        const decision = await pending;
        return decision === 'deny'
          ? { ok: false, output: null, error: 'denied' }
          : { ok: true, output: 'command completed' };
      },
    }),
  };
}

function recoveredTask(
  state: PersistedTask['state'],
  pendingApproval: PersistedTask['pendingApproval'],
): PersistedTask {
  const now = new Date().toISOString();
  return {
    id: '6d082d83-1883-4aa7-a766-1bc495b795e1',
    request: {
      threadId: 'recovered-thread',
      mode: 'cowork',
      model: 'local-test-model',
      messages: [{ role: 'user', content: 'Run both commands.' }],
      policy: 'ask',
      enabledTools: ['run_command'],
    },
    state,
    conversation: [
      { role: 'user', content: 'Run both commands.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          toolCall('call-1', 'npm test'),
          toolCall('call-2', 'rm -rf .'),
        ],
      },
    ],
    iteration: 1,
    events: [],
    pendingApproval,
    activeExecution: {
      toolCallId: 'call-1',
      toolName: 'run_command',
      startedAt: now,
    },
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  };
}

function toolCall(id: string, command: string) {
  return {
    id,
    type: 'function',
    function: { name: 'run_command', arguments: JSON.stringify({ command }) },
  };
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function chunk(delta: NonNullable<StreamChunk['choices'][number]['delta']>): StreamChunk {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'local-test-model',
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}
