import { randomUUID } from 'node:crypto';
import type { Router } from '../providers/router.js';
import type {
  ChatCompletionRequest,
  ContentPart,
  Message,
  ToolCall,
  Usage,
} from '../providers/types.js';
import { redactText, redactValue } from '../tools/security.js';
import { CapabilityRegistry, TaskToolset } from './registry.js';
import { TaskStore } from './store.js';
import type {
  AgentCapabilityRegistration,
  AgentEvent,
  AgentEventKind,
  AgentTaskRequest,
  ApprovalDecision,
  ApprovalDescriptor,
  PendingApproval,
  PersistedTask,
  TaskCheckpoint,
  TaskDispatcher,
  TaskPolicy,
  TaskSnapshot,
  TaskState,
  WorkspaceSnapshot,
} from './types.js';

const MAX_ITERATIONS = 24;
const MAX_TOOL_CALLS_PER_ITERATION = 32;
const MAX_TOOL_ARGUMENT_CONTEXT_CHARACTERS = 300_000;
const MAX_CONTEXT_CHARACTERS = 32_000_000;
const MAX_MESSAGE_CHARACTERS = 16_000_000;
const MAX_TOOL_RESULT_CHARACTERS = 120_000;
const SAVE_DELAY_MS = 1_000;
export const CODE_MODE_INSTRUCTION = 'Code mode: work directly in the selected workspace. Inspect existing code before editing, use file and command tools for implementation, show diffs for changes, and verify the changed behavior before finishing.';

interface ActiveToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface RuntimeTask extends PersistedTask {
  controller?: AbortController;
  approvalResolver?: (decision: ApprovalDecision) => void;
  approvalOverride?: ApprovalDecision;
  activeToolCall?: ActiveToolCall;
  listeners: Set<(event: AgentEvent) => void>;
  saveTimer?: NodeJS.Timeout;
  recovered?: boolean;
  toolset?: TaskToolset;
}

export interface PreparedTaskRequest {
  request: AgentTaskRequest;
  context?: unknown;
}
type NormalizedTaskRequest = AgentTaskRequest & {
  systemPrompt: string;
  policy: TaskPolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
};


export interface TaskRuntimeOptions {
  router: Router;
  store: TaskStore;
  resolveModel?: (request: ChatCompletionRequest) => Promise<string>;
  defaultWorkspace?: () => WorkspaceSnapshot | undefined;
  prepareRequest?: (request: AgentTaskRequest) => Promise<PreparedTaskRequest>;
  registrations?: AgentCapabilityRegistration[];
}

export interface TaskEventSubscription {
  events: AgentEvent[];
  state: TaskState;
  unsubscribe(): void;
}

export class TaskRuntime implements TaskDispatcher {
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly sessionApprovalSignatures = new Map<string, Set<string>>();
  private readonly registry = new CapabilityRegistry();
  private shuttingDown = false;

  constructor(private readonly options: TaskRuntimeOptions) {
    for (const registration of options.registrations ?? []) this.registry.register(registration);
  }

  register(registration: AgentCapabilityRegistration): void {
    this.registry.register(registration);
  }

  async initialize(): Promise<void> {
    for (const persisted of await this.options.store.load()) {
      const task = this.toRuntimeTask(persisted);
      this.tasks.set(task.id, task);
      if (task.request.mode === 'code' && !task.request.workspace) {
        task.state = 'failed';
        task.error = 'Code mode requires a selected workspace.';
        this.appendEvent(task, 'status', { state: 'failed' });
        this.appendEvent(task, 'error', { message: task.error });
        await this.flush(task);
        continue;
      }
      if (task.state === 'planning' || task.state === 'running') {
        task.state = 'running';
        task.recovered = true;
        this.launch(task);
      }
    }
  }

  async dispatch(input: AgentTaskRequest): Promise<{ id: string }> {
    const prepared: PreparedTaskRequest = this.options.prepareRequest
      ? await this.options.prepareRequest(input)
      : { request: input };
    const request = this.normalizeRequest(prepared.request);
    const now = new Date().toISOString();
    const id = randomUUID();
    const conversation = cloneMessages(request.messages);
    applySystemPrompt(conversation, request.systemPrompt);

    const task: RuntimeTask = {
      id,
      request,
      state: request.policy === 'plan' ? 'planning' : 'running',
      conversation,
      iteration: 0,
      events: [],
      checkpoints: [],
      createdAt: now,
      updatedAt: now,
      listeners: new Set(),
    };
    this.tasks.set(id, task);
    this.appendEvent(task, 'status', { state: task.state });
    if (prepared.context !== undefined) this.appendEvent(task, 'context', prepared.context);
    await this.flush(task);
    this.launch(task);
    return { id };
  }

  get(taskId: string): TaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.toSnapshot(task) : undefined;
  }

  subscribe(
    taskId: string,
    afterEventId: number,
    listener: (event: AgentEvent) => void,
  ): TaskEventSubscription | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const events = task.events.filter((event) => event.id > afterEventId);
    task.listeners.add(listener);
    return {
      events,
      state: task.state,
      unsubscribe: () => task.listeners.delete(listener),
    };
  }

  capabilities() {
    return this.registry.listCapabilities();
  }

  async approve(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<TaskSnapshot> {
    const task = this.requireTask(taskId);
    const pending = task.pendingApproval;
    if (!pending || pending.id !== approvalId) throw new TaskRuntimeError('approval not found', 404);
    if (!isApprovalDecision(decision)) throw new TaskRuntimeError('invalid approval decision', 400);

    task.pendingApproval = undefined;
    if (task.state !== 'cancelled') task.state = 'running';
    this.appendEvent(task, 'status', {
      state: task.state,
      approval: { id: approvalId, decision, toolCallId: pending.toolCallId, tool: pending.toolName },
    });
    await this.flush(task);

    if (task.approvalResolver) {
      const resolve = task.approvalResolver;
      task.approvalResolver = undefined;
      resolve(decision);
    } else {
      task.approvalOverride = decision;
      this.launch(task, pending);
    }
    return this.toSnapshot(task);
  }

  async cancel(taskId: string): Promise<TaskSnapshot> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.state)) return this.toSnapshot(task);
    const pending = task.pendingApproval;
    task.state = 'cancelled';
    task.pendingApproval = undefined;
    task.controller?.abort();
    if (task.approvalResolver) {
      const resolve = task.approvalResolver;
      task.approvalResolver = undefined;
      resolve('deny');
    }
    this.appendEvent(task, 'status', {
      state: 'cancelled',
      ...(pending && {
        approval: {
          id: pending.id,
          decision: 'deny',
          toolCallId: pending.toolCallId,
          tool: pending.toolName,
          reason: 'task_cancelled',
        },
      }),
    });
    this.appendEvent(task, 'done', { state: 'cancelled' });
    await this.flush(task);
    return this.toSnapshot(task);
  }

  async undo(taskId: string, checkpointId?: string): Promise<unknown> {
    const task = this.requireTask(taskId);
    const checkpoint = this.findCheckpoint(task, checkpointId);
    if (!checkpoint) throw new TaskRuntimeError('no change is available to undo', 409);

    const controller = new AbortController();
    const toolset = task.toolset ?? await this.createToolset(task, async () => 'allow_once');
    task.toolset = toolset;
    const result = await toolset.undo(checkpoint.registrationId, checkpoint.checkpointId, {
      taskId,
      workspace: task.request.workspace,
      signal: controller.signal,
    });
    task.checkpoints = task.checkpoints.filter((item) => item !== checkpoint);
    this.appendEvent(task, 'tool_result', {
      operation: 'undo',
      name: 'undo',
      checkpointId: checkpoint.checkpointId,
      ok: result?.ok ?? true,
      output: result?.output,
    });
    if (result?.diff !== undefined) {
      this.appendEvent(task, 'file_diff', {
        operation: 'undo',
        name: 'undo',
        checkpointId: checkpoint.checkpointId,
        diff: result.diff,
      });
    }
    task.registrationState = toolset.exportStates();
    await this.flush(task);
    return result ?? { ok: true };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const task of this.tasks.values()) {
      task.controller?.abort();
      if (task.saveTimer) {
        clearTimeout(task.saveTimer);
        task.saveTimer = undefined;
      }
      if (task.approvalResolver) {
        const resolve = task.approvalResolver;
        task.approvalResolver = undefined;
        resolve('deny');
      }
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    for (const task of this.tasks.values()) {
      await task.toolset?.dispose();
      await this.options.store.save(this.toPersistedTask(task));
    }
    await this.options.store.flush();
  }

  private launch(task: RuntimeTask, resumedApproval?: PendingApproval): void {
    if (this.activeRuns.has(task.id) || isTerminal(task.state)) return;
    const run = this.executeTask(task, resumedApproval)
      .catch(async (error: unknown) => {
        if (task.state === 'cancelled' || this.shuttingDown) return;
        task.state = 'failed';
        task.error = String(redactValue(errorMessage(error)));
        this.appendEvent(task, 'status', { state: 'failed' });
        this.appendEvent(task, 'error', { message: task.error });
        await this.flush(task);
      })
      .finally(() => this.activeRuns.delete(task.id));
    this.activeRuns.set(task.id, run);
  }

  private async executeTask(task: RuntimeTask, resumedApproval?: PendingApproval): Promise<void> {
    const controller = new AbortController();
    task.controller = controller;
    if (task.state !== 'waiting_approval') task.state = 'running';
    this.appendEvent(task, 'status', { state: task.state, resumed: task.recovered === true });

    const toolset = task.toolset ?? await this.createToolset(task);
    task.toolset = toolset;
    try {
      if (resumedApproval) {
        const pendingCall = findUnansweredToolCalls(task.conversation)
          .find((call) => call.id === resumedApproval.toolCallId);
        if (pendingCall) {
          await this.executeToolCall(task, pendingCall, toolset, false);
        } else {
          task.activeExecution = undefined;
          this.appendEvent(task, 'context', {
            type: 'recovery',
            message: 'Skipped a recovered approval because its tool call already had a result.',
            toolCallId: resumedApproval.toolCallId,
          });
          await this.flush(task);
        }
        for (const toolCall of findUnansweredToolCalls(task.conversation)) {
          if (isCancelled(task.state)) return;
          await this.executeToolCall(task, toolCall, toolset, true);
        }
      } else if (task.recovered) {
        task.recovered = false;
        for (const toolCall of findUnansweredToolCalls(task.conversation)) {
          if (isCancelled(task.state)) return;
          this.appendEvent(task, 'tool_call', {
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: safeJsonArguments(toolCall.arguments),
            recovered: true,
          });
          this.appendToolResult(task, toolCall, '', {
            ok: false,
            output: null,
            error: 'Tool execution was interrupted by restart and was not retried to prevent duplicate side effects.',
          });
        }
        task.activeExecution = undefined;
        await this.flush(task);
      }

      while (!isCancelled(task.state)) {
        if (task.iteration >= MAX_ITERATIONS) {
          throw new Error(`agent stopped after ${MAX_ITERATIONS} model iterations`);
        }
        task.iteration += 1;

        const bounded = boundConversation(task.conversation);
        if (bounded.omitted > 0 || bounded.truncated) {
          task.conversation = bounded.messages;
          this.appendEvent(task, 'context', {
            compacted: true,
            omittedMessages: bounded.omitted,
            truncated: bounded.truncated,
            approximateCharacters: bounded.characters,
          });
        }

        const definitions = toolset.definitions;
        const request: ChatCompletionRequest = {
          model: task.model ?? task.request.model ?? 'auto',
          messages: task.conversation,
          stream: true,
          stream_options: { include_usage: true },
          ...(definitions.length > 0 && { tools: definitions }),
          ...(task.request.maxTokens !== undefined && { max_tokens: task.request.maxTokens }),
        };
        if (!task.model) {
          if (request.model === 'auto') {
            if (!this.options.resolveModel) throw new Error('no model or model resolver is configured');
            request.model = await this.options.resolveModel(request);
          }
          task.model = request.model;
        } else {
          request.model = task.model;
        }

        const route = this.options.router.route(request.model);
        const provider = route.provider;
        // task.model keeps the selector so a re-run picks the same provider;
        // the upstream only ever sees its own model name.
        request.model = route.model;
        let content = '';
        let reasoning = '';
        let pendingContent = '';
        let pendingReasoning = '';
        const toolCalls = new Map<number, ActiveToolCall>();
        let usage: Usage | undefined;

        for await (const chunk of provider.chatCompletionStream(request, controller.signal)) {
          if (isCancelled(task.state)) return;
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            const safeChunk = completedStreamText(pendingContent + delta.content);
            pendingContent = safeChunk.pending;
            if (safeChunk.completed) {
              this.appendEvent(task, 'assistant_delta', { text: redactText(safeChunk.completed) });
            }
          }
          if (delta?.reasoning) {
            reasoning += delta.reasoning;
            const safeChunk = completedStreamText(pendingReasoning + delta.reasoning);
            pendingReasoning = safeChunk.pending;
            if (safeChunk.completed) {
              this.appendEvent(task, 'reasoning_delta', { text: redactText(safeChunk.completed) });
            }
          }
          mergeToolCallDeltas(toolCalls, delta?.tool_calls ?? []);
          if (chunk.usage) usage = chunk.usage;
        }
        if (pendingContent) this.appendEvent(task, 'assistant_delta', { text: redactText(pendingContent) });
        if (pendingReasoning) this.appendEvent(task, 'reasoning_delta', { text: redactText(pendingReasoning) });
        content = redactText(content);
        reasoning = redactText(reasoning);

        if (usage) this.appendEvent(task, 'usage', usage);
        const calls = [...toolCalls.values()];
        if (calls.length > MAX_TOOL_CALLS_PER_ITERATION) {
          throw new Error(`model requested ${calls.length} tools in one iteration; limit is ${MAX_TOOL_CALLS_PER_ITERATION}`);
        }
        const assistant: Message = {
          role: 'assistant',
          content: content || null,
          ...(reasoning && { reasoning }),
          ...(calls.length > 0 && {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
        };
        task.conversation.push(assistant);

        if (calls.length === 0) {
          task.state = 'completed';
          this.appendEvent(task, 'status', { state: 'completed' });
          this.appendEvent(task, 'done', { state: 'completed', content });
          await this.flush(task);
          return;
        }
        await this.flush(task);

        for (const call of calls) {
          if (isCancelled(task.state)) return;
          await this.executeToolCall(task, call, toolset, true);
        }
      }
    } finally {
      task.controller = undefined;
    }
  }

  private async executeToolCall(
    task: RuntimeTask,
    call: ActiveToolCall,
    toolset: TaskToolset,
    emitCall: boolean,
  ): Promise<void> {
    task.activeToolCall = call;
    if (emitCall) {
      this.appendEvent(task, 'tool_call', {
        toolCallId: call.id,
        name: call.name,
        arguments: safeJsonArguments(call.arguments),
      });
    }

    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.arguments);
    } catch (error) {
      const message = errorMessage(error);
      this.appendToolResult(task, call, '', { ok: false, output: null, error: message });
      task.activeToolCall = undefined;
      await this.flush(task);
      return;
    }
    task.activeExecution = {
      toolCallId: call.id,
      toolName: call.name,
      startedAt: new Date().toISOString(),
    };
    await this.flush(task);

    try {
      const executed = await toolset.execute(call.name, args, {
        taskId: task.id,
        workspace: task.request.workspace,
        signal: task.controller?.signal ?? new AbortController().signal,
      });
      if (task.state === 'cancelled' || this.shuttingDown) return;
      this.appendToolResult(task, call, executed.registrationId, executed.result);
    } catch (error) {
      if (task.state === 'cancelled' || this.shuttingDown) return;
      this.appendToolResult(task, call, '', {
        ok: false,
        output: null,
        error: errorMessage(error),
      });
    } finally {
      task.activeToolCall = undefined;
    }
    task.activeExecution = undefined;
    task.registrationState = toolset.exportStates();
    await this.flush(task);
  }

  private appendToolResult(
    task: RuntimeTask,
    call: ActiveToolCall,
    registrationId: string,
    rawResult: { ok: boolean; output: unknown; error?: string; diff?: unknown; checkpointId?: string; artifact?: unknown },
  ): void {
    const result = redactValue(rawResult) as typeof rawResult;
    this.appendEvent(task, 'tool_result', {
      toolCallId: call.id,
      name: call.name,
      ...result,
    });
    if (result.diff !== undefined) {
      this.appendEvent(task, 'file_diff', {
        toolCallId: call.id,
        name: call.name,
        diff: result.diff,
        checkpointId: result.checkpointId,
      });
    }
    if (result.artifact !== undefined) {
      this.appendEvent(task, 'artifact', {
        toolCallId: call.id,
        name: call.name,
        artifact: result.artifact,
      });
    }
    if (result.checkpointId && registrationId) {
      task.checkpoints.push({
        registrationId,
        checkpointId: result.checkpointId,
        toolCallId: call.id,
      });
    }
    task.conversation.push({
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: truncateText(stringifyToolResult(result), MAX_TOOL_RESULT_CHARACTERS),
    });
  }

  private async createToolset(
    task: RuntimeTask,
    approval: (descriptor: ApprovalDescriptor) => Promise<ApprovalDecision> = (descriptor) =>
      this.awaitApproval(task, descriptor),
  ): Promise<TaskToolset> {
    return this.registry.createToolset({
      taskId: task.id,
      workspace: task.request.workspace,
      policy: task.request.policy as TaskPolicy,
      enabledTools: task.request.enabledTools ?? [],
      requestApproval: approval,
      audit: (kind, payload) => this.appendEvent(task, kind, payload),
    }, task.registrationState);
  }

  private async awaitApproval(
    task: RuntimeTask,
    descriptor: ApprovalDescriptor,
  ): Promise<ApprovalDecision> {
    if (task.approvalOverride) {
      const decision = task.approvalOverride;
      task.approvalOverride = undefined;
      if (decision === 'allow_session') this.rememberSessionApproval(task.id, descriptor);
      return decision;
    }
    if (task.request.policy === 'plan') return 'deny';
    const signature = typeof descriptor.signature === 'string' ? descriptor.signature : undefined;
    if (signature && this.sessionApprovalSignatures.get(task.id)?.has(signature)) return 'allow_session';
    const call = task.activeToolCall;
    if (!call) throw new Error('approval requested outside a tool call');

    const pending: PendingApproval = {
      id: typeof descriptor.id === 'string' ? descriptor.id : randomUUID(),
      toolCallId: call.id,
      toolName: call.name,
      descriptor: redactValue(descriptor) as ApprovalDescriptor,
    };
    const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
      task.approvalResolver = resolve;
    });
    task.pendingApproval = pending;
    task.state = 'waiting_approval';
    this.appendEvent(task, 'status', { state: 'waiting_approval' });
    this.appendEvent(task, 'approval_required', {
      approvalId: pending.id,
      toolCallId: pending.toolCallId,
      name: pending.toolName,
      descriptor: pending.descriptor,
    });
    await this.flush(task);

    const decision = await decisionPromise;
    if (decision === 'allow_session') this.rememberSessionApproval(task.id, descriptor);
    return decision;
  }


  private rememberSessionApproval(taskId: string, descriptor: ApprovalDescriptor): void {
    const signature = typeof descriptor.signature === 'string' ? descriptor.signature : undefined;
    if (!signature) return;
    let signatures = this.sessionApprovalSignatures.get(taskId);
    if (!signatures) {
      signatures = new Set();
      this.sessionApprovalSignatures.set(taskId, signatures);
    }
    signatures.add(signature);
  }

  private appendEvent(task: RuntimeTask, kind: AgentEventKind, payload: unknown): AgentEvent {
    const event: AgentEvent = {
      id: (task.events.at(-1)?.id ?? 0) + 1,
      taskId: task.id,
      kind,
      timestamp: new Date().toISOString(),
      payload: redactValue(payload),
    };
    task.events.push(event);
    task.updatedAt = event.timestamp;
    for (const listener of task.listeners) {
      try {
        listener(event);
      } catch {
        task.listeners.delete(listener);
      }
    }
    this.markDirty(task);
    return event;
  }

  private markDirty(task: RuntimeTask): void {
    if (task.saveTimer) return;
    task.saveTimer = setTimeout(() => {
      task.saveTimer = undefined;
      void this.options.store.save(this.toPersistedTask(task));
    }, SAVE_DELAY_MS);
    task.saveTimer.unref();
  }

  private async flush(task: RuntimeTask): Promise<void> {
    if (task.saveTimer) {
      clearTimeout(task.saveTimer);
      task.saveTimer = undefined;
    }
    await this.options.store.save(this.toPersistedTask(task));
  }

  private normalizeRequest(input: AgentTaskRequest): NormalizedTaskRequest {
    if (!input || typeof input !== 'object') throw new TaskRuntimeError('task request is required', 400);
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new TaskRuntimeError('messages are required', 400);
    }
    if (typeof input.threadId !== 'string' || !input.threadId.trim()) {
      throw new TaskRuntimeError('threadId is required', 400);
    }
    if (input.workspace && (!input.workspace.path || !input.workspace.name)) {
      throw new TaskRuntimeError('workspace path and name are required', 400);
    }
    const policy: TaskPolicy = input.policy === 'trusted' ? 'allow' : (input.policy ?? 'ask');
    if (!['plan', 'ask', 'allow'].includes(policy)) throw new TaskRuntimeError('invalid task policy', 400);
    const workspace = input.workspace ?? this.options.defaultWorkspace?.();
    const mode = typeof input.mode === 'string' && input.mode ? input.mode : 'cowork';
    if (mode === 'code' && !workspace) {
      throw new TaskRuntimeError('Code mode requires a selected workspace.', 400);
    }
    return {
      ...input,
      mode,
      systemPrompt: effectiveSystemPrompt(mode, typeof input.systemPrompt === 'string' ? input.systemPrompt : ''),
      policy,
      enabledTools: Array.isArray(input.enabledTools)
        ? [...new Set(input.enabledTools.filter((name): name is string => typeof name === 'string'))]
        : this.registry.listCapabilities().map((capability) => capability.name),
      enabledSkillIds: Array.isArray(input.enabledSkillIds)
        ? [...new Set(input.enabledSkillIds.filter((id): id is string => typeof id === 'string'))]
        : [],
      ...(workspace && { workspace: { ...workspace } }),
    };
  }

  private toRuntimeTask(task: PersistedTask): RuntimeTask {
    const request = this.normalizeRecoveredRequest(task.request);
    const conversation = Array.isArray(task.conversation)
      ? task.conversation
      : cloneMessages(task.request.messages);
    applySystemPrompt(conversation, request.systemPrompt);
    return {
      ...task,
      request,
      conversation,
      iteration: Number.isFinite(task.iteration) ? task.iteration : 0,
      events: Array.isArray(task.events) ? task.events : [],
      checkpoints: Array.isArray(task.checkpoints) ? task.checkpoints : [],
      listeners: new Set(),
    };
  }

  private normalizeRecoveredRequest(request: AgentTaskRequest): NormalizedTaskRequest {
    const policy: TaskPolicy = request.policy === 'trusted' ? 'allow' : (request.policy ?? 'ask');
    return {
      ...request,
      mode: request.mode || 'cowork',
      systemPrompt: effectiveSystemPrompt(request.mode || 'cowork', request.systemPrompt ?? ''),
      policy,
      enabledTools: request.enabledTools ?? this.registry.listCapabilities().map((item) => item.name),
      enabledSkillIds: request.enabledSkillIds ?? [],
    };
  }

  private toPersistedTask(task: RuntimeTask): PersistedTask {
    return {
      id: task.id,
      request: redactValue(task.request) as AgentTaskRequest,
      state: task.state,
      model: task.model,
      conversation: redactValue(task.conversation) as Message[],
      iteration: task.iteration,
      events: redactValue(task.events) as AgentEvent[],
      pendingApproval: task.pendingApproval
        ? redactValue(task.pendingApproval) as PendingApproval
        : undefined,
      activeExecution: task.activeExecution
        ? redactValue(task.activeExecution) as PersistedTask['activeExecution']
        : undefined,
      checkpoints: task.checkpoints,
      // Raw before-content is required for undo recovery and remains private to the 0600 task file.
      registrationState: task.registrationState,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      error: task.error ? redactText(task.error) : undefined,
    };
  }

  private toSnapshot(task: RuntimeTask): TaskSnapshot {
    return {
      id: task.id,
      threadId: task.request.threadId,
      state: task.state,
      mode: task.request.mode,
      systemPrompt: redactText(task.request.systemPrompt ?? ''),
      workspace: task.request.workspace,
      policy: task.request.policy as TaskPolicy,
      enabledTools: [...(task.request.enabledTools ?? [])],
      enabledSkillIds: [...(task.request.enabledSkillIds ?? [])],
      model: task.model,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      events: redactValue(task.events) as AgentEvent[],
      pendingApproval: task.pendingApproval
        ? redactValue(task.pendingApproval) as PendingApproval
        : undefined,
      error: task.error ? redactText(task.error) : undefined,
    };
  }

  private requireTask(taskId: string): RuntimeTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskRuntimeError('task not found', 404);
    return task;
  }

  private findCheckpoint(task: RuntimeTask, checkpointId?: string): TaskCheckpoint | undefined {
    if (checkpointId) return task.checkpoints.find((item) => item.checkpointId === checkpointId);
    return task.checkpoints.at(-1);
  }
}

export class TaskRuntimeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TaskRuntimeError';
  }
}

function mergeToolCallDeltas(target: Map<number, ActiveToolCall>, deltas: ToolCall[]): void {
  for (const delta of deltas) {
    const index = delta.index ?? 0;
    let call = target.get(index);
    if (!call) {
      call = { id: delta.id ?? randomUUID(), name: '', arguments: '' };
      target.set(index, call);
    }
    if (delta.id) call.id = delta.id;
    if (delta.function.name) call.name += delta.function.name;
    if (delta.function.arguments) call.arguments += delta.function.arguments;
  }
}

function parseArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function safeJsonArguments(value: string): unknown {
  try {
    return parseArguments(value);
  } catch {
    return value;
  }
}

function findToolArguments(messages: Message[], toolCallId: string): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index]?.tool_calls?.find((item) => item.id === toolCallId);
    if (call) return call.function.arguments ?? '';
  }
  return '';
}

function findUnansweredToolCalls(messages: Message[]): ActiveToolCall[] {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant' && (messages[index]?.tool_calls?.length ?? 0) > 0) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return [];
  const answered = new Set(
    messages.slice(assistantIndex + 1).flatMap((message) =>
      message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : [],
    ),
  );
  return (messages[assistantIndex]?.tool_calls ?? [])
    .filter((call) => call.id && !answered.has(call.id))
    .map((call) => ({
      id: call.id!,
      name: call.function.name ?? '',
      arguments: call.function.arguments ?? '',
    }));
}

function boundConversation(messages: Message[]): {
  messages: Message[];
  omitted: number;
  truncated: boolean;
  characters: number;
} {
  const normalized = messages.map(normalizeMessageSize);
  const leadingSystem = normalized[0]?.role === 'system' ? normalized[0] : undefined;
  let characters = leadingSystem ? messageSize(leadingSystem) : 0;
  let start = normalized.length;
  const minimumIndex = leadingSystem ? 1 : 0;
  for (let index = normalized.length - 1; index >= minimumIndex; index -= 1) {
    const size = messageSize(normalized[index]!);
    if (characters + size > MAX_CONTEXT_CHARACTERS && start < normalized.length) break;
    characters += size;
    start = index;
  }

  while (start < normalized.length && normalized[start]?.role === 'tool') start += 1;
  const tail = normalized.slice(start);
  const bounded = leadingSystem ? [leadingSystem, ...tail] : tail;
  const truncated = normalized.some((message, index) => message !== messages[index]);
  return {
    messages: bounded,
    omitted: messages.length - bounded.length,
    truncated,
    characters: bounded.reduce((total, message) => total + messageSize(message), 0),
  };
}

function normalizeMessageSize(message: Message): Message {
  let changed = false;
  let content = message.content;
  if (typeof content === 'string') {
    const limited = truncateText(content, MAX_MESSAGE_CHARACTERS);
    changed = limited !== content;
    content = limited;
  } else if (Array.isArray(content)) {
    let remaining = MAX_MESSAGE_CHARACTERS;
    const parts: ContentPart[] = [];
    for (const part of content) {
      if (remaining <= 0) {
        changed = true;
        break;
      }
      if (part.type === 'image_url' && part.image_url?.url) {
        if (part.image_url.url.length > remaining) {
          parts.push({ type: 'text', text: '[Image omitted because it exceeds the agent context limit]' });
          changed = true;
          remaining = 0;
        } else {
          parts.push(part);
          remaining -= part.image_url.url.length;
        }
      } else {
        const text = part.text ?? '';
        const limited = truncateText(text, remaining);
        parts.push({ ...part, text: limited });
        changed ||= limited !== text;
        remaining -= limited.length;
      }
    }
    if (changed) content = parts;
  }

  const toolCalls = message.tool_calls?.map((call) => {
    const args = call.function.arguments ?? '';
    if (args.length <= MAX_TOOL_ARGUMENT_CONTEXT_CHARACTERS) return call;
    changed = true;
    return {
      ...call,
      function: {
        ...call.function,
        arguments: JSON.stringify({ omitted: 'historical tool arguments exceeded the context limit' }),
      },
    };
  });
  let normalized = changed ? { ...message, content, tool_calls: toolCalls } : message;
  if (messageSize(normalized) <= MAX_MESSAGE_CHARACTERS) return normalized;

  if ((normalized.tool_calls?.length ?? 0) > 0) normalized = { ...normalized, content: null };
  if ((normalized.tool_calls?.length ?? 0) === 0 && typeof normalized.content === 'string') {
    normalized = {
      ...normalized,
      content: truncateText(normalized.content, MAX_MESSAGE_CHARACTERS - normalized.role.length),
    };
  }
  const withoutReasoning = { ...normalized, reasoning: undefined };
  const reasoningBudget = Math.max(0, MAX_MESSAGE_CHARACTERS - messageSize(withoutReasoning));
  return {
    ...withoutReasoning,
    ...(normalized.reasoning && { reasoning: truncateText(normalized.reasoning, reasoningBudget) }),
  };
}

function messageSize(message: Message): number {
  let size = message.role.length + (message.reasoning?.length ?? 0);
  if (typeof message.content === 'string') size += message.content.length;
  else if (Array.isArray(message.content)) {
    for (const part of message.content) size += (part.text?.length ?? 0) + (part.image_url?.url.length ?? 0);
  }
  for (const call of message.tool_calls ?? []) {
    size += (call.id?.length ?? 0) + (call.function.name?.length ?? 0) + (call.function.arguments?.length ?? 0);
  }
  return size;
}

function truncateText(value: string, maximum: number): string {
  if (maximum <= 0) return '';
  if (value.length <= maximum) return value;
  const suffix = '\n…[truncated by agent context limit]';
  if (maximum <= suffix.length) return value.slice(0, maximum);
  return value.slice(0, maximum - suffix.length) + suffix;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function effectiveSystemPrompt(mode: string, systemPrompt: string): string {
  if (mode !== 'code') return systemPrompt;
  const parts = systemPrompt.split(CODE_MODE_INSTRUCTION);
  if (parts.length === 2) return systemPrompt;
  if (parts.length > 2) return `${parts[0]}${CODE_MODE_INSTRUCTION}${parts.slice(1).join('')}`;
  const prompt = systemPrompt.trim();
  return prompt ? `${prompt}\n\n${CODE_MODE_INSTRUCTION}` : CODE_MODE_INSTRUCTION;
}

function applySystemPrompt(messages: Message[], systemPrompt: string): void {
  if (!systemPrompt) return;
  if (systemPrompt.includes(CODE_MODE_INSTRUCTION)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== 'system' || typeof message.content !== 'string') continue;
      message.content = message.content
        .split(CODE_MODE_INSTRUCTION)
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!message.content) messages.splice(index, 1);
    }
  }
  const first = messages[0];
  if (
    first?.role === 'system'
    && typeof first.content === 'string'
    && (first.content === systemPrompt || systemPrompt.startsWith(`${first.content}\n\n`))
  ) {
    first.content = systemPrompt;
    return;
  }
  messages.unshift({ role: 'system', content: systemPrompt });
}

function cloneMessages(messages: Message[]): Message[] {
  return structuredClone(messages);
}


function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === 'allow_once' || value === 'allow_session' || value === 'deny';
}

function isTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isCancelled(state: TaskState): boolean {
  return state === 'cancelled';
}

function completedStreamText(value: string): { completed: string; pending: string } {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const code = value.charCodeAt(index);
    if (code === 32 || (code >= 9 && code <= 13)) {
      return { completed: value.slice(0, index + 1), pending: value.slice(index + 1) };
    }
  }
  return { completed: '', pending: value };
}

