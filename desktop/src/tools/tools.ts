import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Tool } from '../providers/types.js';
import { createUnifiedDiff, truncateUtf8 } from './diff.js';
import {
  CommandSafetyError,
  commandEnvironment,
  parseCommand,
  redactText,
  redactValue,
  type ParsedCommand,
} from './security.js';
import { Workspace, WorkspaceError } from './workspace.js';
export { CommandSafetyError };

export const CORE_TOOL_NAMES = [
  'read_file',
  'list_directory',
  'update_todo',
  'write_file',
  'run_command',
  'git_status',
  'git_diff',
  'git_commit',
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type ToolPolicy = 'plan' | 'ask' | 'allow';
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';
export type ApprovalCapability = 'write' | 'command' | 'git';

export interface ApprovalRisk {
  level: 'medium' | 'high';
  summary: string;
  reasons: string[];
}

export interface ApprovalDescriptor {
  id: string;
  tool: CoreToolName;
  capability: ApprovalCapability;
  title: string;
  detail: string;
  risk: ApprovalRisk;
  input: unknown;
  diff?: string;
}

export type Approver = (descriptor: ApprovalDescriptor) => Promise<ApprovalDecision>;

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  tool: CoreToolName;
  /** Redacted, size-bounded content suitable for a model tool-result message. */
  content: string;
  data?: unknown;
  checkpointId?: string;
  diff?: string;
  truncated?: boolean;
}
export type TodoUpdateStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoUpdateItem {
  id: string;
  text: string;
  status: TodoUpdateStatus;
}

export interface TodoUpdatePayload {
  items: TodoUpdateItem[];
}


export type AuditAction =
  | 'requested'
  | 'approval_required'
  | 'approval_decided'
  | 'succeeded'
  | 'failed'
  | 'undo_succeeded';

export interface ToolAuditRecord {
  id: string;
  timestamp: string;
  tool: CoreToolName | 'undo';
  action: AuditAction;
  policy: ToolPolicy;
  data: unknown;
}

export interface ToolboxOptions {
  policy?: ToolPolicy;
  enabledTools?: Iterable<string>;
  approval?: Approver;
  onAudit?: (record: ToolAuditRecord) => void;
  onTodo?: (payload: TodoUpdatePayload) => void;
  /** Previously exported task checkpoints to restore after an app restart. */
  checkpoints?: Iterable<SerializedToolCheckpoint>;
}

export interface CoreToolRegistrationOptions extends ToolboxOptions {
  workspace: Workspace;
}

export interface CoreToolRegistration {
  definitions: Tool[];
  execute(name: string, input: string | unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult>;
  undo(checkpointId: string, context?: ToolExecutionContext): Promise<ToolExecutionResult>;
  auditRecords(): ToolAuditRecord[];
  /** Sensitive local recovery state. Persist it, but never emit it as an event or audit record. */
  exportCheckpoints(): SerializedToolCheckpoint[];
}

export class ToolDenied extends Error {
  constructor(
    public readonly tool: string,
    message = `the ${tool} tool was not permitted for this request`,
  ) {
    super(message);
    this.name = 'ToolDenied';
  }
}

export class ApprovalRequired extends Error {
  constructor(public readonly descriptor: ApprovalDescriptor) {
    super(`approval is required to use ${descriptor.tool}`);
    this.name = 'ApprovalRequired';
  }
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 100_000;
const MAX_TOOL_INPUT_BYTES = 6_100_000;
const MAX_DIFF_BYTES = 200_000;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_CHECKPOINTS = 100;
const MAX_AUDIT_RECORDS = 1_000;
const MAX_AUDIT_DATA_BYTES = 16_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMIT_MESSAGE_BYTES = 10_000;
const MAX_TODO_ITEMS = 50;
const MAX_TODO_ID_BYTES = 128;
const MAX_TODO_CONTENT_BYTES = 2_000;
const MAX_TODO_TOTAL_BYTES = 20_000;

export interface CheckpointFileSnapshot {
  content: string;
  mode: number;
}

export interface SerializedToolCheckpoint {
  id: string;
  /** Canonical workspace-relative path, never an absolute path. */
  path: string;
  before: CheckpointFileSnapshot | null;
  afterHash: string;
}

type ExistingFile = CheckpointFileSnapshot;
type Checkpoint = SerializedToolCheckpoint;

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface DirEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}

export const CORE_TOOL_DEFINITIONS: Tool[] = [
  functionTool('read_file', 'Read a UTF-8 text file inside the selected workspace.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
    required: ['path'],
    additionalProperties: false,
  }),
  functionTool('list_directory', 'List one directory level inside the selected workspace.', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Workspace-relative directory path; defaults to the root.' } },
    additionalProperties: false,
  }),
  functionTool('update_todo', 'Replace the ordered task todo state so progress stays visible to the user.', {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TODO_ITEMS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: MAX_TODO_ID_BYTES },
            content: { type: 'string', minLength: 1, maxLength: MAX_TODO_CONTENT_BYTES },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['id', 'content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  }),
  functionTool('write_file', 'Replace or create one UTF-8 file. Returns a unified diff and an undo checkpoint.', {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      content: { type: 'string', description: 'Complete replacement content.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  }),
  functionTool('run_command', 'Run one shell-free command in the workspace. Shell operators and unsafe executables are rejected.', {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS },
    },
    required: ['command'],
    additionalProperties: false,
  }),
  functionTool('git_status', 'Show guarded git status for a repository rooted exactly at the workspace.', {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }),
  functionTool('git_diff', 'Show a guarded working-tree or staged diff without external diff drivers.', {
    type: 'object',
    properties: {
      staged: { type: 'boolean' },
      path: { type: 'string', description: 'Optional workspace-relative path filter.' },
    },
    additionalProperties: false,
  }),
  functionTool('git_commit', 'Commit already-staged changes without hooks or signing. Staging and destructive git are unavailable.', {
    type: 'object',
    properties: { message: { type: 'string', minLength: 1, maxLength: MAX_COMMIT_MESSAGE_BYTES } },
    required: ['message'],
    additionalProperties: false,
  }),
];

/** Creates the complete, task-scoped registration consumed by the iterative runtime. */
export function createCoreToolRegistration(options: CoreToolRegistrationOptions): CoreToolRegistration {
  const enabledTools = new Set(options.enabledTools ?? CORE_TOOL_NAMES);
  const toolbox = new Toolbox(options.workspace, { ...options, enabledTools });
  return {
    definitions: CORE_TOOL_DEFINITIONS
      .filter((definition) => enabledTools.has(definition.function?.name ?? ''))
      .map((definition) => structuredClone(definition)),
    execute: (name, input, context) => toolbox.execute(name, input, context),
    undo: (checkpointId, context) => toolbox.undo(checkpointId, context),
    auditRecords: () => toolbox.auditRecords(),
    exportCheckpoints: () => toolbox.exportCheckpoints(),
  };
}

export class Toolbox {
  private readonly enabledTools: Set<string>;
  private readonly sessionApprovals = new Set<string>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly auditLog: ToolAuditRecord[] = [];
  private policy: ToolPolicy;
  private readonly approval?: Approver;
  private readonly onAudit?: (record: ToolAuditRecord) => void;
  private readonly onTodo?: (payload: TodoUpdatePayload) => void;

  constructor(private readonly workspace: Workspace, options: ToolboxOptions = {}) {
    this.policy = options.policy ?? 'ask';
    this.enabledTools = new Set(options.enabledTools ?? CORE_TOOL_NAMES);
    this.approval = options.approval;
    this.onAudit = options.onAudit;
    this.onTodo = options.onTodo;
    if (options.checkpoints) {
      for (const checkpoint of options.checkpoints) this.restoreCheckpoint(checkpoint);
    }
  }

  setPolicy(policy: ToolPolicy): void {
    this.policy = policy;
    this.sessionApprovals.clear();
  }

  getPolicy(): ToolPolicy {
    return this.policy;
  }

  auditRecords(): ToolAuditRecord[] {
    return this.auditLog.map((record) => structuredClone(record));
  }
  exportCheckpoints(): SerializedToolCheckpoint[] {
    return [...this.checkpoints.values()].map((checkpoint) => structuredClone(checkpoint));
  }

  async execute(
    name: string,
    input: string | unknown,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    const tool = requireCoreToolName(name);
    const args = parseToolInput(input);
    this.emitAudit(tool, 'requested', { input: auditToolInput(tool, args) });

    try {
      context.signal?.throwIfAborted();
      const result = await this.dispatch(tool, args, context);
      this.emitAudit(tool, 'succeeded', { result: auditResult(result) });
      return result;
    } catch (error) {
      if (error instanceof ApprovalRequired) {
        this.emitAudit(tool, 'approval_required', { approval: error.descriptor });
      } else {
        this.emitAudit(tool, 'failed', { error: errorMessage(error) });
      }
      throw error;
    }
  }

  async undo(checkpointId: string, context: ToolExecutionContext = {}): Promise<ToolExecutionResult> {
    this.emitAudit('undo', 'requested', { checkpointId });
    try {
      const checkpoint = this.checkpoints.get(checkpointId);
      if (!checkpoint) throw new ToolInputError(`unknown or expired checkpoint: ${checkpointId}`);
      context.signal?.throwIfAborted();

      const resolved = await this.workspace.resolveInside(checkpoint.path);
      const root = requireWorkspaceRoot(this.workspace);
      if (relativeToWorkspace(root, resolved) !== checkpoint.path) {
        throw new WorkspaceError('checkpoint path no longer resolves to the original file');
      }
      const current = await readExistingTextFile(resolved, MAX_WRITE_BYTES);
      if (!current || digest(current.content) !== checkpoint.afterHash) {
        throw new WorkspaceError('file changed after the checkpoint; refusing to overwrite newer work');
      }

      const diff = boundedDiff(checkpoint.path, current.content, checkpoint.before?.content ?? null);
      if (checkpoint.before) {
        await atomicWrite(this.workspace, resolved, checkpoint.before.content, checkpoint.before.mode);
      } else {
        await rm(resolved);
      }
      this.checkpoints.delete(checkpointId);

      const result: ToolExecutionResult = {
        tool: 'write_file',
        content: `Restored ${checkpoint.path} from checkpoint ${checkpointId}.`,
        data: { path: checkpoint.path, checkpointId },
        checkpointId,
        diff,
      };
      this.emitAudit('undo', 'undo_succeeded', { result: auditResult(result) });
      return result;
    } catch (error) {
      this.emitAudit('undo', 'failed', { checkpointId, error: errorMessage(error) });
      throw error;
    }
  }

  private async dispatch(
    tool: CoreToolName,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    switch (tool) {
      case 'read_file':
        exactKeys(args, ['path']);
        return this.readTextFile(requireString(args, 'path'), context);
      case 'list_directory':
        exactKeys(args, ['path']);
        return this.listDirectory(optionalString(args, 'path') ?? '.', context);
      case 'update_todo':
        exactKeys(args, ['items']);
        return this.updateTodo(args.items);
      case 'write_file':
        exactKeys(args, ['path', 'content']);
        return this.writeTextFile(requireString(args, 'path'), requireString(args, 'content'), context);
      case 'run_command':
        exactKeys(args, ['command', 'timeout_ms']);
        return this.runCommand(
          requireString(args, 'command'),
          optionalInteger(args, 'timeout_ms') ?? DEFAULT_COMMAND_TIMEOUT_MS,
          context,
        );
      case 'git_status':
        exactKeys(args, []);
        return this.gitStatus(context);
      case 'git_diff':
        exactKeys(args, ['staged', 'path']);
        return this.gitDiff(optionalBoolean(args, 'staged') ?? false, optionalString(args, 'path'), context);
      case 'git_commit':
        exactKeys(args, ['message']);
        return this.gitCommit(requireString(args, 'message'), context);
    }
  }

  private async readTextFile(path: string, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.assertAvailable('read_file');
    await this.authorize('read_file', undefined, context, {
      title: `Read ${path}`,
      detail: `Read a text file from ${path}.`,
      input: { path },
    });
    const resolved = await this.workspace.resolveInside(path);
    const displayPath = await this.workspace.relativePath(resolved);
    const file = await readExistingTextFile(resolved, MAX_FILE_BYTES);
    if (!file) throw new WorkspaceError(`file does not exist: ${path}`);

    const safe = truncateUtf8(redactText(file.content), MAX_OUTPUT_BYTES);
    return {
      tool: 'read_file',
      content: safe.value,
      data: { path: displayPath, bytes: Buffer.byteLength(file.content, 'utf8') },
      truncated: safe.truncated,
    };
  }

  private async listDirectory(path: string, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.assertAvailable('list_directory');
    await this.authorize('list_directory', undefined, context, {
      title: `List ${path}`,
      detail: `List one directory level at ${path}.`,
      input: { path },
    });
    const resolved = await this.workspace.resolveInside(path);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new WorkspaceError(`${path} is not a directory`);

    const allEntries = await readdir(resolved, { withFileTypes: true });
    allEntries.sort((left, right) => left.name.localeCompare(right.name));
    const entries: DirEntry[] = [];
    let encodedBytes = Buffer.byteLength('{"entries":[],"truncated":false}', 'utf8');
    for (const entry of allEntries) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
      const candidate: DirEntry = {
        path: redactText(relativeToWorkspace(this.workspace.selected!, join(resolved, entry.name))),
        type: entry.isDirectory()
          ? 'directory'
          : entry.isFile()
            ? 'file'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'other',
      };
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1;
      if (encodedBytes + candidateBytes > MAX_OUTPUT_BYTES - 64) break;
      entries.push(candidate);
      encodedBytes += candidateBytes;
    }
    const truncated = entries.length < allEntries.length;
    const content = JSON.stringify({ entries, truncated });
    return {
      tool: 'list_directory',
      content,
      data: { entries, truncated },
      truncated,
    };
  }

  private updateTodo(value: unknown): ToolExecutionResult {
    this.assertAvailable('update_todo');
    const items = requireTodoItems(value);
    if (!this.onTodo) throw new Error('update_todo requires a todo event sink');
    const payload: TodoUpdatePayload = { items };
    this.onTodo(structuredClone(payload));

    const counts: Record<TodoUpdateStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
    };
    for (const item of items) counts[item.status] += 1;
    return {
      tool: 'update_todo',
      content: `Updated ${items.length} todo items: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`,
      data: payload,
    };
  }

  private async writeTextFile(
    path: string,
    content: string,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.assertAvailable('write_file', 'write');
    if (content.includes('\0')) throw new ToolInputError('content must be UTF-8 text without null bytes');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new ToolInputError(`content is ${bytes} bytes, over the ${MAX_WRITE_BYTES} byte write limit`);
    }

    const resolved = await this.workspace.resolveInside(path);
    const displayPath = await this.workspace.relativePath(resolved);
    if (displayPath === '.') throw new WorkspaceError('cannot replace the workspace directory');
    const before = await readExistingTextFile(resolved, MAX_WRITE_BYTES);
    if (before?.content === content) {
      return {
        tool: 'write_file',
        content: `${displayPath} already has the requested content; no file was changed.`,
        data: { path: displayPath, bytes, changed: false },
      };
    }
    const diff = boundedDiff(displayPath, before?.content ?? null, content);

    await this.authorize('write_file', 'write', context, {
      title: `${before ? 'Replace' : 'Create'} ${displayPath}`,
      detail: `${before ? 'Replace' : 'Create'} ${displayPath} with ${bytes} bytes of text.`,
      input: { path: displayPath, bytes },
      signatureInput: { path: displayPath, content },
      diff,
    });

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      path: displayPath,
      before,
      afterHash: digest(content),
    };
    context.signal?.throwIfAborted();
    this.rememberCheckpoint(checkpoint);
    try {
      await atomicWrite(this.workspace, resolved, content, before?.mode);
    } catch (error) {
      this.checkpoints.delete(checkpoint.id);
      throw error;
    }

    return {
      tool: 'write_file',
      content: `Wrote ${displayPath} (${bytes} bytes). Undo checkpoint: ${checkpoint.id}.`,
      data: { path: displayPath, bytes, created: before === null },
      checkpointId: checkpoint.id,
      diff,
    };
  }

  private async runCommand(
    command: string,
    timeoutMs: number,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.assertAvailable('run_command', 'command');
    if (timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
      throw new ToolInputError(`timeout_ms must be between 1 and ${MAX_COMMAND_TIMEOUT_MS}`);
    }
    const parsed = parseCommand(command);
    const confined = await confineCommandPaths(parsed, this.workspace);

    await this.authorize('run_command', 'command', context, {
      title: `Run ${basename(confined.executable)}`,
      detail: `Run one shell-free command in the selected workspace (timeout ${timeoutMs} ms).`,
      input: { command, timeout_ms: timeoutMs },
      risk: {
        level: 'high',
        summary: 'This command can modify workspace files or contact external services.',
        reasons: ['Commands run as your local user.', 'Output is capped and inherited credentials are removed.'],
      },
    });

    const root = requireWorkspaceRoot(this.workspace);
    const processResult = await runProcess(
      confined.executable,
      confined.args,
      root,
      commandEnvironment(root),
      timeoutMs,
      context.signal,
    );
    const result = redactProcessResult(processResult);
    const output = truncateUtf8(JSON.stringify(result), MAX_OUTPUT_BYTES);
    return {
      tool: 'run_command',
      content: output.value,
      data: result,
      truncated: result.truncated || output.truncated,
    };
  }

  private async gitStatus(context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.assertAvailable('git_status', 'git');
    await this.authorize('git_status', 'git', context, {
      title: 'Inspect git status',
      detail: 'Read repository branch and working-tree status.',
      input: {},
      risk: {
        level: 'medium',
        summary: 'Git will inspect repository metadata.',
        reasons: ['The command is read-only.', 'Global git config and external helpers are disabled.'],
      },
    });
    await this.ensureGitRoot(context.signal);
    const result = await this.runGit(['status', '--short', '--branch', '--untracked-files=all'], context.signal);
    requireSuccessfulProcess('git status', result);
    return processToolResult('git_status', result);
  }

  private async gitDiff(
    staged: boolean,
    path: string | undefined,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    this.assertAvailable('git_diff', 'git');
    let displayPath: string | undefined;
    if (path !== undefined) displayPath = await this.workspace.relativePath(path);

    await this.authorize('git_diff', 'git', context, {
      title: `Inspect ${staged ? 'staged' : 'working-tree'} diff`,
      detail: `Read the ${staged ? 'staged' : 'working-tree'} diff${displayPath ? ` for ${displayPath}` : ''}.`,
      input: { staged, path: displayPath },
      risk: {
        level: 'medium',
        summary: 'Git will read file changes and repository metadata.',
        reasons: ['External diff and text-conversion drivers are disabled.'],
      },
    });
    await this.ensureGitRoot(context.signal);

    const args = ['diff', '--no-ext-diff', '--no-textconv'];
    if (staged) args.push('--cached');
    if (displayPath) args.push('--', displayPath);
    const result = await this.runGit(args, context.signal, MAX_DIFF_BYTES);
    requireSuccessfulProcess('git diff', result);
    return processToolResult('git_diff', result, MAX_DIFF_BYTES);
  }

  private async gitCommit(message: string, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.assertAvailable('git_commit', 'git');
    const messageBytes = Buffer.byteLength(message, 'utf8');
    if (message.trim() === '') throw new ToolInputError('commit message must not be empty');
    if (messageBytes > MAX_COMMIT_MESSAGE_BYTES) {
      throw new ToolInputError(`commit message exceeds the ${MAX_COMMIT_MESSAGE_BYTES} byte limit`);
    }
    await this.ensureGitRoot(context.signal);
    const staged = await this.runGit(
      ['diff', '--cached', '--no-ext-diff', '--no-textconv'],
      context.signal,
      MAX_DIFF_BYTES,
    );
    requireSuccessfulProcess('git diff --cached', staged);
    if (staged.truncated) {
      throw new ToolInputError(`staged diff exceeds the ${MAX_DIFF_BYTES} byte review limit`);
    }
    if (staged.stdout === '') throw new ToolInputError('nothing is staged to commit');
    const safeDiff = truncateUtf8(redactText(staged.stdout), MAX_DIFF_BYTES).value;

    await this.authorize('git_commit', 'git', context, {
      title: 'Commit staged changes',
      detail: `Create a commit from the already-staged changes with message “${redactText(message)}”.`,
      input: { message },
      signatureInput: { message, stagedDiff: staged.stdout },
      diff: safeDiff,
      risk: {
        level: 'high',
        summary: 'This writes repository history.',
        reasons: ['Only already-staged changes are committed.', 'Hooks, signing, aliases, and external helpers are disabled.'],
      },
    });

    context.signal?.throwIfAborted();
    const result = await this.runGit(
      ['commit', '--no-verify', '--no-gpg-sign', '-m', message],
      context.signal,
    );
    requireSuccessfulProcess('git commit', result);
    return processToolResult('git_commit', result);
  }

  private async ensureGitRoot(signal?: AbortSignal): Promise<void> {
    const root = requireWorkspaceRoot(this.workspace);
    const result = await this.runGit(['rev-parse', '--show-toplevel'], signal);
    requireSuccessfulProcess('git rev-parse', result);
    const reportedRoot = result.stdout.trim();
    if (!isAbsolute(reportedRoot)) throw new WorkspaceError('git returned an invalid repository root');
    const confinedRoot = await this.workspace.resolveInside(reportedRoot);
    if (confinedRoot !== root) {
      throw new WorkspaceError('the selected workspace must be the git repository root');
    }

    const gitDirectory = await this.runGit(['rev-parse', '--absolute-git-dir'], signal);
    requireSuccessfulProcess('git rev-parse --absolute-git-dir', gitDirectory);
    const reportedGitDirectory = gitDirectory.stdout.trim();
    if (!isAbsolute(reportedGitDirectory)) throw new WorkspaceError('git returned an invalid metadata path');
    await this.workspace.resolveInside(reportedGitDirectory);
  }

  private runGit(args: string[], signal?: AbortSignal, outputLimit = MAX_OUTPUT_BYTES): Promise<ProcessResult> {
    const root = requireWorkspaceRoot(this.workspace);
    const environment = commandEnvironment(root);
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GIT_ASKPASS = '';
    environment.GIT_PAGER = 'cat';
    environment.GIT_OPTIONAL_LOCKS = '0';
    return runProcess(
      'git',
      [
        '--no-pager',
        '--literal-pathspecs',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'commit.gpgSign=false',
        '-c', 'diff.external=',
        ...args,
      ],
      root,
      environment,
      MAX_COMMAND_TIMEOUT_MS,
      signal,
      outputLimit,
    );
  }

  private async authorize(
    tool: CoreToolName,
    capability: ApprovalCapability | undefined,
    context: ToolExecutionContext,
    details: Omit<ApprovalDescriptor, 'id' | 'tool' | 'capability' | 'risk'> & {
      risk?: ApprovalRisk;
      signatureInput?: unknown;
    },
  ): Promise<void> {
    this.assertAvailable(tool, capability);
    if (capability === undefined) return;
    const alwaysRequiresApproval = tool === 'run_command' || tool === 'git_commit';
    if (this.policy !== 'ask' && !alwaysRequiresApproval) return;

    const risk = details.risk ?? defaultRisk(capability);
    const signature = approvalSignature(tool, capability, details.signatureInput ?? details.input, risk);
    if (this.sessionApprovals.has(signature)) return;
    const descriptor: ApprovalDescriptor = {
      id: randomUUID(),
      tool,
      capability,
      title: details.title,
      detail: details.detail,
      risk,
      input: redactValue(details.input),
      ...(details.diff === undefined ? {} : { diff: redactText(details.diff) }),
    };
    if (!this.approval) throw new ApprovalRequired(descriptor);

    this.emitAudit(tool, 'approval_required', { approval: descriptor });
    context.signal?.throwIfAborted();
    const decision = await abortable(this.approval(structuredClone(descriptor)), context.signal);
    context.signal?.throwIfAborted();
    this.emitAudit(tool, 'approval_decided', { approvalId: descriptor.id, decision });
    if (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'deny') {
      throw new ToolDenied(tool, `approval returned an invalid decision for ${tool}`);
    }
    if (decision === 'deny') throw new ToolDenied(tool, `approval was denied for ${tool}`);
    if (decision === 'allow_session') this.sessionApprovals.add(signature);
  }

  private assertAvailable(tool: CoreToolName, capability?: ApprovalCapability): void {
    if (!this.enabledTools.has(tool)) throw new ToolDenied(tool, `${tool} is not enabled for this task`);
    if (
      this.policy === 'plan'
      && capability !== undefined
      && tool !== 'git_status'
      && tool !== 'git_diff'
    ) {
      throw new ToolDenied(tool, `${tool} is unavailable in plan mode`);
    }
  }

  private restoreCheckpoint(value: unknown): void {
    this.rememberCheckpoint(requireSerializedCheckpoint(value));
  }

  private rememberCheckpoint(checkpoint: Checkpoint): void {
    this.checkpoints.set(checkpoint.id, checkpoint);
    if (this.checkpoints.size <= MAX_CHECKPOINTS) return;
    const oldest = this.checkpoints.keys().next().value;
    if (typeof oldest === 'string') this.checkpoints.delete(oldest);
  }

  private emitAudit(tool: CoreToolName | 'undo', action: AuditAction, data: unknown): void {
    const record: ToolAuditRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      tool,
      action,
      policy: this.policy,
      data: boundedAuditData(data),
    };
    this.auditLog.push(record);
    if (this.auditLog.length > MAX_AUDIT_RECORDS) this.auditLog.shift();
    this.onAudit?.(structuredClone(record));
  }
}

function functionTool(name: CoreToolName, description: string, parameters: unknown): Tool {
  return { type: 'function', function: { name, description, parameters } };
}

function requireCoreToolName(name: string): CoreToolName {
  if ((CORE_TOOL_NAMES as readonly string[]).includes(name)) return name as CoreToolName;
  throw new ToolInputError(`unknown core tool: ${name}`);
}

function parseToolInput(input: string | unknown): Record<string, unknown> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_TOOL_INPUT_BYTES) {
      throw new ToolInputError(`tool arguments exceed the ${MAX_TOOL_INPUT_BYTES} byte limit`);
    }
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new ToolInputError('tool arguments must be valid JSON');
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolInputError('tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function exactKeys(args: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new ToolInputError(`unknown tool argument: ${unknown.join(', ')}`);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];

  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} must be a string`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ToolInputError(`${key} must be a boolean`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolInputError(`${key} must be an integer`);
  }
  return value;
}
function requireTodoItems(value: unknown): TodoUpdateItem[] {
  if (!Array.isArray(value)) throw new ToolInputError('items must be an array');
  if (value.length === 0) throw new ToolInputError('items must contain at least one todo');
  if (value.length > MAX_TODO_ITEMS) {
    throw new ToolInputError(`items exceeds the ${MAX_TODO_ITEMS} todo limit`);
  }

  const ids = new Set<string>();
  const items: TodoUpdateItem[] = [];
  let totalBytes = 0;
  for (const [index, candidate] of value.entries()) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ToolInputError(`items[${index}] must be an object`);
    }
    const unknownKeys = Object.keys(candidate)
      .filter((key) => key !== 'id' && key !== 'content' && key !== 'status');
    if (unknownKeys.length > 0) {
      throw new ToolInputError(`items[${index}] has unknown fields: ${unknownKeys.join(', ')}`);
    }
    if (
      !('id' in candidate)
      || typeof candidate.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate.id)
      || Buffer.byteLength(candidate.id, 'utf8') > MAX_TODO_ID_BYTES
      || redactText(candidate.id) !== candidate.id
    ) {
      throw new ToolInputError(`items[${index}].id is invalid`);
    }
    if (ids.has(candidate.id)) throw new ToolInputError(`duplicate todo id: ${candidate.id}`);
    ids.add(candidate.id);

    if (
      !('content' in candidate)
      || typeof candidate.content !== 'string'
      || candidate.content.trim() === ''
      || candidate.content.includes('\0')
      || Buffer.byteLength(candidate.content, 'utf8') > MAX_TODO_CONTENT_BYTES
    ) {
      throw new ToolInputError(`items[${index}].content is invalid`);
    }
    if (!('status' in candidate) || !isTodoUpdateStatus(candidate.status)) {
      throw new ToolInputError(`items[${index}].status is invalid`);
    }

    const text = redactText(candidate.content);
    totalBytes += Buffer.byteLength(candidate.id, 'utf8') + Buffer.byteLength(text, 'utf8');
    if (totalBytes > MAX_TODO_TOTAL_BYTES) {
      throw new ToolInputError(`todo content exceeds the ${MAX_TODO_TOTAL_BYTES} byte total limit`);
    }
    items.push({ id: candidate.id, text, status: candidate.status });
  }
  return items;
}

function isTodoUpdateStatus(value: unknown): value is TodoUpdateStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}
function approvalSignature(
  tool: CoreToolName,
  capability: ApprovalCapability,
  input: unknown,
  risk: ApprovalRisk,
): string {
  return digest(stableJson({ tool, capability, input, risk }));
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((child) => stableJson(child)).join(',')}]`;

  const fields = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
  return `{${fields.join(',')}}`;
}


function defaultRisk(capability: ApprovalCapability): ApprovalRisk {
  if (capability === 'write') {
    return {
      level: 'medium',
      summary: 'This replaces a workspace file.',
      reasons: ['A pre-write checkpoint is retained for undo.', 'The proposed diff is shown for review.'],
    };
  }
  if (capability === 'git') {
    return {
      level: 'medium',
      summary: 'Git will inspect or update repository state.',
      reasons: ['Destructive git commands are never exposed.'],
    };
  }
  return {
    level: 'high',
    summary: 'This command runs as your local user.',
    reasons: ['Shell syntax is disabled.', 'Inherited credentials are removed.'],
  };
}

function requireSerializedCheckpoint(value: unknown): SerializedToolCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError('checkpoint state must be an object');
  }
  if (!('id' in value) || typeof value.id !== 'string' || value.id === '' || value.id.length > 200) {
    throw new ToolInputError('checkpoint state has an invalid id');
  }
  if (
    !('path' in value)
    || typeof value.path !== 'string'
    || value.path === ''
    || value.path === '.'
    || value.path.length > 4_096
    || value.path.includes('\0')
    || value.path.includes('\\')
    || isAbsolute(value.path)
    || value.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ToolInputError('checkpoint state has an invalid workspace-relative path');
  }
  if (!('afterHash' in value) || typeof value.afterHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.afterHash)) {
    throw new ToolInputError('checkpoint state has an invalid content hash');
  }
  if (!('before' in value)) throw new ToolInputError('checkpoint state is missing its prior file snapshot');

  let before: CheckpointFileSnapshot | null = null;
  if (value.before !== null) {
    if (
      typeof value.before !== 'object'
      || Array.isArray(value.before)
      || !('content' in value.before)
      || typeof value.before.content !== 'string'
      || value.before.content.includes('\0')
      || Buffer.byteLength(value.before.content, 'utf8') > MAX_WRITE_BYTES
      || !('mode' in value.before)
      || typeof value.before.mode !== 'number'
      || !Number.isInteger(value.before.mode)
      || value.before.mode < 0
      || value.before.mode > 0o177777
    ) {
      throw new ToolInputError('checkpoint state has an invalid prior file snapshot');
    }
    before = { content: value.before.content, mode: value.before.mode };
  }

  return {
    id: value.id,
    path: value.path,
    before,
    afterHash: value.afterHash,
  };
}

async function readExistingTextFile(path: string, maxBytes: number): Promise<ExistingFile | null> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile()) throw new WorkspaceError(`${path} is not a regular file`);
  if (info.size > maxBytes) {
    throw new WorkspaceError(`${path} is ${info.size} bytes, over the ${maxBytes} byte limit`);
  }

  const bytes = await readFile(path);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceError(`${path} is not valid UTF-8 text`);
  }
  if (content.includes('\0')) throw new WorkspaceError(`${path} appears to be a binary file`);
  return { content, mode: info.mode };
}

async function atomicWrite(
  workspace: Workspace,
  target: string,
  content: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const checkedTarget = await workspace.resolveInside(target);
  if (checkedTarget !== target) throw new WorkspaceError('write target changed while preparing the file');

  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.cowork-tmp`);
  const checkedTemporary = await workspace.resolveInside(temporary);
  try {
    await writeFile(checkedTemporary, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: mode === undefined ? 0o666 : mode & 0o7777,
    });
    await rename(checkedTemporary, checkedTarget);
  } catch (error) {
    await rm(checkedTemporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function confineCommandPaths(parsed: ParsedCommand, workspace: Workspace): Promise<ParsedCommand> {
  let executable = parsed.executable;
  if (executable.includes('/') || executable.includes(sep)) {
    executable = await workspace.resolveInside(executable);
  }

  for (const argument of parsed.args) {
    if (/^https?:\/\//i.test(argument)) continue;
    if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(argument) || /(?:^|[=,:])~(?:$|[\\/])/.test(argument)) {
      throw new WorkspaceError(`path traversal is not allowed in command arguments: ${argument}`);
    }
    if (
      /^file:/i.test(argument)
      || /(?:^|[=,:])\/(?!\/)/.test(argument)
      || /(?:^|[=,:])[A-Za-z]:[\\/]/.test(argument)
      || /(?:^|[=,:])\\\\/.test(argument)
    ) {
      throw new WorkspaceError(`absolute paths are not allowed in command arguments: ${argument}`);
    }
    if (argument.startsWith('-') && !argument.includes('=')) {
      if (argument.includes('/') || argument.includes('\\')) {
        throw new WorkspaceError(`path-bearing options must use a workspace-relative value: ${argument}`);
      }
      continue;
    }

    const candidate = argument.startsWith('-')
      ? argument.slice(argument.indexOf('=') + 1)
      : argument;
    if (candidate === '') continue;
    await workspace.resolveInside(candidate);
  }

  return { executable, args: parsed.args };
}

function requireWorkspaceRoot(workspace: Workspace): string {
  const root = workspace.selected;
  if (!root) throw new WorkspaceError('no project folder selected');
  return root;
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  outputLimit = MAX_OUTPUT_BYTES,
): Promise<ProcessResult> {
  signal?.throwIfAborted();

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killGraceTimer: NodeJS.Timeout | undefined;

    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = outputLimit - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) truncated = true;
      target.push(Buffer.from(chunk.subarray(0, remaining)));
      capturedBytes += Math.min(chunk.length, remaining);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));

    const abort = () => {
      aborted = true;
      terminate();
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killGraceTimer);
      signal?.removeEventListener('abort', abort);
    };
    const settle = (exitCode: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error && !timedOut && !aborted) {
        reject(error);
        return;
      }
      if (aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('tool execution was aborted'));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        timedOut,
        truncated,
      });
    };
    const killProcessGroup = () => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The process exited between the timeout and signal.
        }
      }
    };
    function terminate() {
      if (settled || killGraceTimer) return;
      clearTimeout(timer);
      killProcessGroup();
      // A descendant can inherit stdio and prevent `close`; do not let that
      // keep a timed-out tool or the desktop process alive indefinitely.
      killGraceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(null);
      }, 250);
    }

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    child.once('error', (error) => settle(null, error));
    child.once('close', (exitCode) => settle(exitCode));
  });
}
async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('tool execution was aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}


function redactProcessResult(result: ProcessResult, outputLimit = MAX_OUTPUT_BYTES): ProcessResult {
  const stdout = truncateUtf8(redactText(result.stdout), outputLimit);
  const remaining = Math.max(0, outputLimit - Buffer.byteLength(stdout.value, 'utf8'));
  const stderr = remaining === 0 && result.stderr !== ''
    ? { value: '', truncated: true }
    : truncateUtf8(redactText(result.stderr), remaining);
  return {
    ...result,
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: result.truncated || stdout.truncated || stderr.truncated,
  };
}

function requireSuccessfulProcess(label: string, result: ProcessResult): void {
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.exitCode !== 0) {
    const detail = truncateUtf8(redactText(result.stderr || result.stdout).trim(), 8_000).value;
    throw new Error(`${label} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
  }
}

function processToolResult(
  tool: CoreToolName,
  processResult: ProcessResult,
  outputLimit = MAX_OUTPUT_BYTES,
): ToolExecutionResult {
  const result = redactProcessResult(processResult, outputLimit);
  const content = result.stdout || result.stderr || `${tool} completed with no output`;
  return { tool, content, data: result, truncated: result.truncated };
}

function relativeToWorkspace(root: string, path: string): string {
  const value = relative(root, path);
  return value === '' ? '.' : value.split(sep).join('/');
}

function boundedDiff(path: string, before: string | null, after: string | null): string {
  return truncateUtf8(redactText(createUnifiedDiff(path, before, after)), MAX_DIFF_BYTES).value;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function auditToolInput(tool: CoreToolName, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'read_file':
    case 'list_directory':
      return { path: boundedAuditField(args.path, 4_096) };
    case 'update_todo': {
      if (!Array.isArray(args.items)) return { items: '[invalid non-array value]' };
      return {
        itemCount: args.items.length,
        items: args.items.slice(0, MAX_TODO_ITEMS).map((candidate) => {
          if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return { value: '[invalid non-object value]' };
          }
          return {
            id: 'id' in candidate ? boundedAuditField(candidate.id, MAX_TODO_ID_BYTES) : undefined,
            status: 'status' in candidate ? boundedAuditField(candidate.status, 32) : undefined,
            contentBytes: 'content' in candidate && typeof candidate.content === 'string'
              ? Buffer.byteLength(candidate.content, 'utf8')
              : undefined,
          };
        }),
      };
    }
    case 'write_file':
      return {
        path: boundedAuditField(args.path, 4_096),
        contentBytes: typeof args.content === 'string' ? Buffer.byteLength(args.content, 'utf8') : undefined,
      };
    case 'run_command':
      return {
        command: boundedAuditField(args.command, 32_000),
        timeout_ms: args.timeout_ms,
      };
    case 'git_status':
      return {};
    case 'git_diff':
      return {
        staged: args.staged,
        path: boundedAuditField(args.path, 4_096),
      };
    case 'git_commit':
      return { message: boundedAuditField(args.message, MAX_COMMIT_MESSAGE_BYTES) };
  }
}

function boundedAuditField(value: unknown, maxBytes: number): unknown {
  if (typeof value !== 'string') {
    return value === undefined || value === null || typeof value !== 'object'
      ? value
      : '[invalid object value]';
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes <= maxBytes ? value : { bytes, omitted: true };
}

function boundedAuditData(data: unknown): unknown {
  const safe = redactValue(data);
  let encoded: string;
  try {
    encoded = JSON.stringify(safe) ?? String(safe);
  } catch {
    encoded = String(safe);
  }
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_AUDIT_DATA_BYTES) return safe;
  return {
    truncated: true,
    preview: truncateUtf8(encoded, MAX_AUDIT_DATA_BYTES).value,
  };
}

function auditResult(result: ToolExecutionResult): unknown {
  const preview = truncateUtf8(result.content, 8_000);
  return {
    tool: result.tool,
    content: preview.value,
    checkpointId: result.checkpointId,
    diff: result.diff ? truncateUtf8(result.diff, 8_000).value : undefined,
    truncated: result.truncated || preview.truncated,
  };
}

function errorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}
