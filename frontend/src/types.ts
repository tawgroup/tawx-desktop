export type Role = 'system' | 'user' | 'assistant';
export type AppMode = 'chat' | 'cowork' | 'code';
export type CoworkSection = 'tasks' | 'schedules' | 'tools' | 'skills';
export type ThreadPolicy = 'plan' | 'ask' | 'allow';
export type TaskStatus =
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface Workspace {
  path: string;
  name: string;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text';
  dataUrl?: string;
  text?: string;
  truncated?: boolean;
}

export interface ContextBudget {
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  compactedMessages: number;
  compactionCount: number;
  updatedAt: number;
  lastCompactedAt?: number;
  summary?: string;
}

export interface Message {
  id: string;
  chatId: string;
  role: Role;
  content: string;
  /** Local project snapshot sent to the model but hidden from the chat transcript. */
  context?: string;
  attachments?: Attachment[];
  taskId?: string;
  createdAt: number;
  /** Populated when the assistant turn failed; renders inline as an error bubble. */
  error?: string;
  model?: string;
  providerName?: string;
  reasoning?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Missing on legacy conversations, which belong to Chat. */
  mode?: AppMode;
  /** Per-chat override; falls back to global settings only until a legacy chat is next saved. */
  model?: string;
  systemPrompt?: string;
  workspace?: Workspace;
  policy?: ThreadPolicy;
  enabledTools?: string[];
  enabledSkillIds?: string[];
  context?: ContextBudget;
  taskId?: string;
  taskStatus?: TaskStatus;
}

export interface ThreadDraft {
  mode: AppMode;
  systemPrompt: string;
  workspace?: Workspace;
  policy: ThreadPolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
  context: ContextBudget;
}

export const chatMode = (chat: Chat): AppMode => chat.mode ?? 'chat';

export type ProviderKind = 'gateway' | 'openrouter' | 'openai-compatible' | 'ollama' | 'anthropic';
export type ProviderAuthKind = 'bearer' | 'none';
export type ProviderConnectionStatus = 'untested' | 'testing' | 'connected' | 'error';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  /** OpenAI-compatible base URL up to and including /v1. */
  baseUrl: string;
  authKind: ProviderAuthKind;
  /**
   * Empty for a `managed` provider: the key is held by the main process and
   * never reaches this browser profile.
   */
  apiKey: string;
  enabled: boolean;
  model: string;
  discoveredModels: string[];
  connectionStatus: ProviderConnectionStatus;
  lastCheckedAt?: number;
  lastError?: string;
  /**
   * `managed` means the desktop main process owns this record and its key, and
   * requests for it go through the gateway as `<id>/<model>`. `local` means the
   * record lives in this browser profile and is called directly — the only mode
   * available when the bundle is served by the Go gateway.
   */
  ownership?: 'managed' | 'local';
  /** True when the record comes from config.yaml and cannot be edited here. */
  readOnly?: boolean;
  /** Managed providers report whether a key is held, never the key itself. */
  hasApiKey?: boolean;
}

export interface Settings {
  providers: Provider[];
  activeProviderId: string | null;
  temperature: number;
  maxTokens: number | null;
  systemPrompt: string;
  theme: 'light' | 'dark' | 'system' | 'reading';
  /** Typeface for message text only; the UI chrome stays sans. */
  contentFont: 'sans' | 'serif';
  contentSize: 'sm' | 'md' | 'lg' | 'xl';
  streaming: boolean;
  sendOnEnter: boolean;
  webSearch: boolean;
  webSearchEngine: WebSearchEngine;
  coworkPolicy: ThreadPolicy;
  coworkEnabledTools: string[];
  coworkContextTokens: number;
}

export type WebSearchEngine = 'auto' | 'exa' | 'parallel' | 'perplexity';

export interface ModelInfo {
  id: string;
  owned_by?: string;
}

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatImagePart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

/** Wire format for OpenAI-compatible chat completion and desktop task requests. */
export interface ChatCompletionMessage {
  role: Role;
  content: string | ChatContentPart[];
}

export interface ContextPreview {
  systemPrompt: string;
  workspace?: Workspace;
  policy: ThreadPolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
  attachments: Attachment[];
  messages: ChatCompletionMessage[];
  budget: ContextBudget;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface CompletionUsage {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface StreamDelta {
  model?: string;
  usage?: CompletionUsage;
  choices?: Array<{
    delta?: { content?: string; reasoning?: string; role?: Role };
    finish_reason?: string | null;
  }>;
}

export interface CompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  usage?: CompletionUsage;
}

export type TaskEventKind =
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

export interface TaskEvent<P = unknown> {
  id: string;
  taskId: string;
  kind: TaskEventKind;
  timestamp: number;
  payload: P;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface TaskTodo {
  id: string;
  text: string;
  status: TodoStatus;
  detail?: string;
  updatedAt: number;
}

export type ToolCallStatus =
  | 'pending'
  | 'waiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied';

export interface TaskToolCall {
  id: string;
  name: string;
  arguments: unknown;
  status: ToolCallStatus;
  approvalId?: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface TaskApproval {
  id: string;
  toolCallId?: string;
  tool: string;
  arguments: unknown;
  reason?: string;
  status: 'pending' | 'allowed' | 'denied';
  decision?: ApprovalDecision;
  requestedAt: number;
  resolvedAt?: number;
}

export interface TaskFileDiff {
  id: string;
  path: string;
  diff: string;
  operation?: 'create' | 'modify' | 'delete' | 'rename';
  toolCallId?: string;
  timestamp: number;
  undone?: boolean;
}

export interface TaskArtifact {
  id: string;
  name: string;
  type: string;
  url?: string;
  path?: string;
  content?: string;
  size?: number;
  createdAt: number;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface CoworkTask {
  id: string;
  threadId: string;
  status: TaskStatus;
  mode: AppMode;
  model?: string;
  systemPrompt: string;
  workspace?: Workspace;
  policy: ThreadPolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
  createdAt: number;
  updatedAt: number;
  events: TaskEvent[];
  todos: TaskTodo[];
  toolCalls: TaskToolCall[];
  approvals: TaskApproval[];
  diffs: TaskFileDiff[];
  artifacts: TaskArtifact[];
  context: ContextBudget;
  usage: TaskUsage;
  assistantContent: string;
  reasoning: string;
  error?: string;
  lastEventId?: string;
}

export interface DesktopTaskRequest {
  threadId: string;
  mode: AppMode;
  messages: ChatCompletionMessage[];
  systemPrompt: string;
  workspace?: Workspace;
  policy: ThreadPolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
}

export interface DesktopPendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  descriptor: Record<string, unknown>;
}

export interface DesktopTaskSnapshot {
  id: string;
  threadId: string;
  state?: TaskStatus;
  status?: TaskStatus;
  mode: AppMode;
  model?: string;
  systemPrompt: string;
  workspace?: Workspace;
  policy: ThreadPolicy;
  enabledTools: string[];
  enabledSkillIds?: string[];
  createdAt: number | string;
  updatedAt: number | string;
  events?: TaskEvent[];
  pendingApproval?: DesktopPendingApproval;
  error?: string;
}

export const CORE_TOOLS = [
  'read_file',
  'list_directory',
  'write_file',
  'run_command',
  'git_status',
  'git_diff',
  'git_commit',
  'update_todo',
] as const;

export const DEFAULT_COWORK_TOOLS: string[] = [
  'read_file',
  'list_directory',
  'git_status',
  'git_diff',
  'update_todo',
];

export const DEFAULT_CONTEXT_TOKENS = 64_000;

export const DEFAULT_SETTINGS: Settings = {
  providers: [{
    id: 'gateway',
    name: 'LLM Gateway',
    kind: 'gateway',
    baseUrl: '/v1',
    authKind: 'none',
    apiKey: 'not-needed',
    enabled: true,
    model: 'auto',
    discoveredModels: ['auto'],
    connectionStatus: 'connected',
  }],
  activeProviderId: 'gateway',
  temperature: 1,
  maxTokens: null,
  systemPrompt: '',
  theme: 'system',
  contentFont: 'sans',
  contentSize: 'md',
  streaming: true,
  sendOnEnter: true,
  webSearch: false,
  webSearchEngine: 'auto',
  coworkPolicy: 'ask',
  coworkEnabledTools: DEFAULT_COWORK_TOOLS,
  coworkContextTokens: DEFAULT_CONTEXT_TOKENS,
};
