import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Message, Tool } from '../providers/types.js';

export type TaskState =
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPolicy = 'plan' | 'ask' | 'allow';
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface WorkspaceSnapshot {
  path: string;
  name: string;
}

export interface AgentTaskRequest {
  threadId: string;
  mode: string;
  messages: Message[];
  systemPrompt?: string;
  workspace?: WorkspaceSnapshot;
  policy?: TaskPolicy | 'trusted';
  enabledTools?: string[];
  enabledSkillIds?: string[];
  model?: string;
  maxTokens?: number;
}

export type AgentEventKind =
  | 'status'
  | 'assistant_delta'
  | 'reasoning_delta'
  | 'todo'
  | 'tool_call'
  | 'approval_required'
  | 'tool_result'
  | 'file_diff'
  | 'artifact'
  | 'context'
  | 'usage'
  | 'done'
  | 'error';

export interface AgentEvent {
  id: number;
  taskId: string;
  kind: AgentEventKind;
  timestamp: string;
  payload: unknown;
}

export interface PendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  descriptor: ApprovalDescriptor;
}

export interface ApprovalDescriptor {
  id?: string;
  tool?: string;
  capability?: string;
  title?: string;
  action?: string;
  detail?: string;
  risk?: unknown;
  input?: unknown;
  diff?: string;
  signature?: string;
}

export interface TaskCheckpoint {
  registrationId: string;
  checkpointId: string;
  toolCallId: string;
}

export interface ToolExecutionMarker {
  toolCallId: string;
  toolName: string;
  startedAt: string;
}

export interface PersistedTask {
  id: string;
  request: AgentTaskRequest;
  state: TaskState;
  model?: string;
  conversation: Message[];
  iteration: number;
  events: AgentEvent[];
  pendingApproval?: PendingApproval;
  activeExecution?: ToolExecutionMarker;
  checkpoints: TaskCheckpoint[];
  /** Capability-private local recovery data. Never include this in TaskSnapshot or events. */
  registrationState?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface TaskSnapshot {
  id: string;
  threadId: string;
  state: TaskState;
  mode: string;
  systemPrompt: string;
  workspace?: WorkspaceSnapshot;
  policy: TaskPolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
  model?: string;
  createdAt: string;
  updatedAt: string;
  events: AgentEvent[];
  pendingApproval?: PendingApproval;
  error?: string;
}

export interface ToolCapability {
  name: string;
  description: string;
  category?: string;
}

export interface ToolExecutionContext {
  taskId: string;
  workspace?: WorkspaceSnapshot;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: unknown;
  error?: string;
  diff?: unknown;
  checkpointId?: string;
  artifact?: unknown;
}

export interface ToolUndoResult {
  ok?: boolean;
  output?: unknown;
  diff?: unknown;
}

export interface TaskToolRegistration {
  definitions: Tool[];
  execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  undo?(checkpointId: string, context: ToolExecutionContext): Promise<ToolUndoResult | void>;
  exportState?(): unknown;
  dispose?(): void | Promise<void>;
}

export interface TaskRegistrationContext {
  taskId: string;
  workspace?: WorkspaceSnapshot;
  policy: TaskPolicy;
  enabledTools: string[];
  recoveryState?: unknown;
  requestApproval(descriptor: ApprovalDescriptor): Promise<ApprovalDecision>;
  audit(kind: AgentEventKind, payload: unknown): void;
}

/** A capability factory is registered once, then instantiated in each task's security context. */
export interface AgentCapabilityRegistration {
  id: string;
  capabilities: ToolCapability[];
  create(context: TaskRegistrationContext): TaskToolRegistration | Promise<TaskToolRegistration>;
}

export interface TaskDispatcher {
  dispatch(request: AgentTaskRequest): Promise<{ id: string }>;
}

export interface DesktopHttpContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

/** Return true only after writing a complete response. */
export type DesktopHttpHandler = (context: DesktopHttpContext) => boolean | Promise<boolean>;

