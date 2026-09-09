import type {
  ApprovalDecision,
  ContextBudget,
  CoworkTask,
  DesktopTaskRequest,
  DesktopTaskSnapshot,
  TaskApproval,
  TaskArtifact,
  TaskEvent,
  TaskFileDiff,
  TaskStatus,
  TaskTodo,
  TaskToolCall,
  ThreadPolicy,
} from '../types';

const TASK_STATUSES: Record<TaskStatus, true> = {
  planning: true,
  running: true,
  waiting_approval: true,
  completed: true,
  failed: true,
  cancelled: true,
};

const TODO_STATUSES: Record<TaskTodo['status'], true> = {
  pending: true,
  in_progress: true,
  completed: true,
  failed: true,
  cancelled: true,
};

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

function textValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function taskStatus(value: unknown): TaskStatus | undefined {
  return typeof value === 'string' && TASK_STATUSES[value as TaskStatus]
    ? value as TaskStatus
    : undefined;
}

function policy(value: unknown): ThreadPolicy {
  if (value === 'plan' || value === 'allow') return value;
  if (value === 'trusted') return 'allow';
  return 'ask';
}

function timestamp(value: number | string): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function emptyContext(maxTokens: number, now = Date.now()): ContextBudget {
  return {
    usedTokens: 0,
    maxTokens,
    remainingTokens: maxTokens,
    compactedMessages: 0,
    compactionCount: 0,
    updatedAt: now,
  };
}


export function createCoworkTask(
  id: string,
  request: DesktopTaskRequest,
  maxTokens: number,
  now = Date.now(),
): CoworkTask {
  return {
    id,
    threadId: request.threadId,
    status: 'planning',
    mode: request.mode,
    systemPrompt: request.systemPrompt,
    workspace: request.workspace,
    policy: request.policy,
    enabledTools: [...request.enabledTools],
    enabledSkillIds: [...request.enabledSkillIds],
    createdAt: now,
    updatedAt: now,
    events: [],
    todos: [],
    toolCalls: [],
    approvals: [],
    diffs: [],
    artifacts: [],
    context: emptyContext(maxTokens, now),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    assistantContent: '',
    reasoning: '',
  };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = { ...next[index], ...item };
  return next;
}

function reduceStatus(task: CoworkTask, event: TaskEvent): CoworkTask {
  const value = objectPayload(event.payload);
  const status = taskStatus(value.status ?? value.state ?? event.payload) ?? task.status;
  const resolved = objectPayload(value.approval);
  const approvalId = textValue(resolved.id, resolved.approvalId);
  const decision = textValue(resolved.decision);
  if (!approvalId || (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'deny')) {
    return { ...task, status };
  }
  const approvalDecision: ApprovalDecision = decision === 'deny'
    ? 'deny'
    : decision === 'allow_once'
      ? 'allow_once'
      : 'allow_session';
  const approvals = task.approvals.map((approval) => approval.id === approvalId
    ? {
        ...approval,
        status: decision === 'deny' ? 'denied' as const : 'allowed' as const,
        decision: approvalDecision,
        resolvedAt: event.timestamp,
      }
    : approval);
  const toolCallId = textValue(resolved.toolCallId);
  const toolCalls = task.toolCalls.map((call) => call.id === toolCallId
    ? { ...call, status: decision === 'deny' ? 'denied' as const : 'running' as const }
    : call);
  return { ...task, status, approvals, toolCalls };
}

function reduceTodo(task: CoworkTask, event: TaskEvent): CoworkTask {
  const root = objectPayload(event.payload);
  const items = Array.isArray(root.todos) ? root.todos : Array.isArray(root.items) ? root.items : null;
  if (items) {
    const todos: TaskTodo[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const value = objectPayload(item);
      const id = textValue(value.id, value.todoId);
      const text = textValue(value.text, value.title, value.description);
      const candidateStatus = textValue(value.status);
      if (
        !id
        || seen.has(id)
        || !text
        || !candidateStatus
        || !TODO_STATUSES[candidateStatus as TaskTodo['status']]
      ) continue;
      seen.add(id);
      const existing = task.todos.find((todo) => todo.id === id);
      todos.push({
        id,
        text,
        status: candidateStatus as TaskTodo['status'],
        detail: Object.prototype.hasOwnProperty.call(value, 'detail')
          ? textValue(value.detail)
          : existing?.detail,
        updatedAt: event.timestamp,
      });
    }
    return { ...task, todos };
  }
  const value = objectPayload(root.todo ?? root);
  const id = textValue(value.id, value.todoId) ?? event.id;
  const existing = task.todos.find((todo) => todo.id === id);
  const text = textValue(value.text, value.title, value.description) ?? existing?.text;
  if (!text) return task;
  const candidateStatus = textValue(value.status);
  const todo: TaskTodo = {
    id,
    text,
    status: candidateStatus && TODO_STATUSES[candidateStatus as TaskTodo['status']]
      ? candidateStatus as TaskTodo['status']
      : existing?.status ?? 'pending',
    detail: textValue(value.detail) ?? existing?.detail,
    updatedAt: event.timestamp,
  };
  return { ...task, todos: upsert(task.todos, todo) };
}

function reduceToolCall(task: CoworkTask, event: TaskEvent): CoworkTask {
  const root = objectPayload(event.payload);
  const value = objectPayload(root.toolCall ?? root.call ?? root);
  const id = textValue(value.id, value.toolCallId, value.callId) ?? event.id;
  const existing = task.toolCalls.find((call) => call.id === id);
  const call: TaskToolCall = {
    id,
    name: textValue(value.name, value.tool, value.toolName) ?? existing?.name ?? 'tool',
    arguments: value.arguments ?? value.args ?? value.input ?? existing?.arguments ?? {},
    status: existing?.status === 'waiting_approval' ? 'waiting_approval' : 'running',
    approvalId: textValue(value.approvalId) ?? existing?.approvalId,
    result: existing?.result,
    error: existing?.error,
    startedAt: existing?.startedAt ?? event.timestamp,
    completedAt: existing?.completedAt,
  };
  return { ...task, status: 'running', toolCalls: upsert(task.toolCalls, call) };
}

function reduceApproval(task: CoworkTask, event: TaskEvent): CoworkTask {
  const root = objectPayload(event.payload);
  const descriptor = objectPayload(root.descriptor);
  const id = textValue(root.id, root.approvalId) ?? event.id;
  const toolCallId = textValue(root.toolCallId, descriptor.toolCallId);
  const tool = textValue(root.tool, root.toolName, root.name, descriptor.tool, descriptor.action) ?? 'tool';
  const approval: TaskApproval = {
    id,
    toolCallId,
    tool,
    arguments: root.arguments ?? root.args ?? root.input ?? descriptor,
    reason: textValue(root.reason, descriptor.detail, descriptor.risk),
    status: 'pending',
    requestedAt: event.timestamp,
  };
  const toolCalls = toolCallId
    ? task.toolCalls.map((call) => call.id === toolCallId
      ? { ...call, approvalId: id, status: 'waiting_approval' as const }
      : call)
    : task.toolCalls;
  return {
    ...task,
    status: 'waiting_approval',
    approvals: upsert(task.approvals, approval),
    toolCalls,
  };
}

function reduceToolResult(task: CoworkTask, event: TaskEvent): CoworkTask {
  const root = objectPayload(event.payload);
  const value = objectPayload(root.toolResult ?? root.resultEnvelope ?? root);
  const id = textValue(value.toolCallId, value.callId, value.id);
  if (!id) return task;
  const ok = typeof value.ok === 'boolean' ? value.ok : !value.error;
  const existing = task.toolCalls.find((call) => call.id === id);
  const call: TaskToolCall = {
    id,
    name: textValue(value.name, value.tool, value.toolName) ?? existing?.name ?? 'tool',
    arguments: existing?.arguments ?? {},
    status: ok ? 'completed' : 'failed',
    approvalId: existing?.approvalId,
    result: value.output ?? value.result,
    error: textValue(value.error),
    startedAt: existing?.startedAt ?? event.timestamp,
    completedAt: event.timestamp,
  };
  return { ...task, status: 'running', toolCalls: upsert(task.toolCalls, call) };
}

function reduceFileDiff(task: CoworkTask, event: TaskEvent): CoworkTask {
  const root = objectPayload(event.payload);
  const value = objectPayload(root.fileDiff ?? root);
  const diffText = textValue(value.diff, value.patch, value.content) ?? '';
  const headerPath = diffText.match(/^\+\+\+ (?:b\/)?([^\n]+)/m)?.[1];
  const operation = textValue(value.operation);
  const diff: TaskFileDiff = {
    id: textValue(value.id, value.checkpointId) ?? event.id,
    path: textValue(value.path, value.file) ?? (headerPath && headerPath !== '/dev/null' ? headerPath : 'workspace'),
    diff: diffText,
    operation: operation === 'create' || operation === 'modify' || operation === 'delete' || operation === 'rename'
      ? operation
      : undefined,
    toolCallId: textValue(value.toolCallId),
    timestamp: event.timestamp,
    undone: value.undone === true || operation === 'undo',
  };
  return { ...task, diffs: upsert(task.diffs, diff) };
}

function reduceArtifact(task: CoworkTask, event: TaskEvent): CoworkTask {
  const root = objectPayload(event.payload);
  const value = objectPayload(root.artifact ?? root);
  const preview = objectPayload(value.preview);
  const path = textValue(value.path);
  const artifact: TaskArtifact = {
    id: textValue(value.id) ?? event.id,
    name: textValue(value.name, value.filename) ?? path?.split('/').at(-1) ?? 'Artifact',
    type: textValue(value.type, value.mimeType, preview.kind) ?? 'application/octet-stream',
    url: textValue(value.url),
    path,
    content: textValue(value.content, preview.content),
    size: numberValue(value.size),
    createdAt: event.timestamp,
  };
  return { ...task, artifacts: upsert(task.artifacts, artifact) };
}

function reduceContext(task: CoworkTask, event: TaskEvent): CoworkTask {
  const value = objectPayload(event.payload);
  const maxTokens = numberValue(value.maxTokens, value.limit, value.max_tokens) ?? task.context.maxTokens;
  const approximateCharacters = numberValue(value.approximateCharacters);
  const usedTokens = numberValue(value.usedTokens, value.used, value.totalTokens, value.total_tokens)
    ?? (approximateCharacters === undefined ? task.context.usedTokens : Math.ceil(approximateCharacters / 4));
  const omittedMessages = numberValue(value.compactedMessages, value.omittedMessages);
  const compactedMessages = omittedMessages ?? task.context.compactedMessages;
  const didCompact = value.compacted === true || (omittedMessages ?? 0) > 0;
  const compactionCount = numberValue(value.compactionCount, value.compactions)
    ?? task.context.compactionCount + (didCompact ? 1 : 0);
  return {
    ...task,
    context: {
      usedTokens,
      maxTokens,
      remainingTokens: numberValue(value.remainingTokens, value.remaining) ?? Math.max(0, maxTokens - usedTokens),
      compactedMessages,
      compactionCount,
      updatedAt: event.timestamp,
      lastCompactedAt: didCompact ? event.timestamp : task.context.lastCompactedAt,
      summary: textValue(value.summary) ?? task.context.summary,
    },
  };
}

function reduceUsage(task: CoworkTask, event: TaskEvent): CoworkTask {
  const value = objectPayload(event.payload);
  const inputTokens = numberValue(value.inputTokens, value.input_tokens, value.promptTokens, value.prompt_tokens) ?? 0;
  const outputTokens = numberValue(value.outputTokens, value.output_tokens, value.completionTokens, value.completion_tokens) ?? 0;
  const totalTokens = numberValue(value.totalTokens, value.total_tokens) ?? inputTokens + outputTokens;
  const cost = numberValue(value.cost);
  return {
    ...task,
    usage: {
      inputTokens: task.usage.inputTokens + inputTokens,
      outputTokens: task.usage.outputTokens + outputTokens,
      totalTokens: task.usage.totalTokens + totalTokens,
      cost: cost === undefined ? task.usage.cost : (task.usage.cost ?? 0) + cost,
    },
    context: inputTokens > 0
      ? {
          ...task.context,
          usedTokens: inputTokens,
          remainingTokens: Math.max(0, task.context.maxTokens - inputTokens),
          updatedAt: event.timestamp,
        }
      : task.context,
  };
}

/** Pure, idempotent reducer used for live SSE and persisted-event replay. */
export function reduceTaskEvent(task: CoworkTask, event: TaskEvent): CoworkTask {
  if (event.taskId !== task.id) return task;
  if (event.id && task.events.some((candidate) => candidate.id === event.id)) return task;

  let next: CoworkTask = {
    ...task,
    events: [...task.events, event],
    updatedAt: Math.max(task.updatedAt, event.timestamp),
    lastEventId: event.id || task.lastEventId,
  };
  const value = objectPayload(event.payload);

  switch (event.kind) {
    case 'status':
      next = reduceStatus(next, event);
      break;
    case 'assistant_delta':
      next = { ...next, assistantContent: next.assistantContent + (textValue(event.payload, value.delta, value.content, value.text) ?? '') };
      break;
    case 'reasoning_delta':
      next = { ...next, reasoning: next.reasoning + (textValue(event.payload, value.delta, value.content, value.text) ?? '') };
      break;
    case 'todo':
      next = reduceTodo(next, event);
      break;
    case 'tool_call':
      next = reduceToolCall(next, event);
      break;
    case 'approval_required':
      next = reduceApproval(next, event);
      break;
    case 'tool_result':
      next = reduceToolResult(next, event);
      break;
    case 'file_diff':
      next = reduceFileDiff(next, event);
      break;
    case 'artifact':
      next = reduceArtifact(next, event);
      break;
    case 'context':
      next = reduceContext(next, event);
      break;
    case 'usage':
      next = reduceUsage(next, event);
      break;
    case 'done':
      next = { ...next, status: taskStatus(value.state ?? value.status) ?? 'completed' };
      break;
    case 'error':
      next = { ...next, status: 'failed', error: textValue(event.payload, value.message, value.error) ?? 'Task failed' };
      break;
  }
  return next;
}

export function taskFromSnapshot(snapshot: DesktopTaskSnapshot, maxTokens: number): CoworkTask {
  const createdAt = timestamp(snapshot.createdAt);
  const request: DesktopTaskRequest = {
    threadId: snapshot.threadId,
    mode: snapshot.mode === 'chat' || snapshot.mode === 'code' ? snapshot.mode : 'cowork',
    messages: [],
    systemPrompt: snapshot.systemPrompt ?? '',
    workspace: snapshot.workspace,
    policy: policy(snapshot.policy),
    enabledTools: snapshot.enabledTools ?? [],
    enabledSkillIds: snapshot.enabledSkillIds ?? [],
  };
  let task = createCoworkTask(snapshot.id, request, maxTokens, createdAt);
  task = {
    ...task,
    status: taskStatus(snapshot.state ?? snapshot.status) ?? 'running',
    model: snapshot.model,
    updatedAt: timestamp(snapshot.updatedAt),
    error: snapshot.error,
  };
  for (const event of snapshot.events ?? []) task = reduceTaskEvent(task, event);
  const pending = snapshot.pendingApproval;
  if (pending && !task.approvals.some((approval) => approval.id === pending.id)) {
    const requestedAt = timestamp(snapshot.updatedAt);
    task = {
      ...task,
      status: 'waiting_approval',
      approvals: [...task.approvals, {
        id: pending.id,
        toolCallId: pending.toolCallId,
        tool: pending.toolName,
        arguments: pending.descriptor,
        reason: textValue(pending.descriptor.detail, pending.descriptor.risk),
        status: 'pending' as const,
        requestedAt,
      }],
      toolCalls: task.toolCalls.map((call) => call.id === pending.toolCallId
        ? { ...call, approvalId: pending.id, status: 'waiting_approval' as const }
        : call),
    };
  }
  return task;
}
