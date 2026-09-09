import { createHmac, randomBytes } from 'node:crypto';
import { redactText, redactValue } from '../tools/security.js';
import type { Tool } from '../providers/types.js';
export { redactText as redactSensitiveText, redactValue as redactSensitive };


export type CapabilityRisk = 'read' | 'write' | 'external';
export type CapabilityPolicy = 'plan' | 'ask' | 'allow';
const MAX_APPROVAL_INPUT_BYTES = 64 * 1024;
export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface CapabilityStatus {
  id: string;
  name: string;
  available: boolean;
  configured: boolean;
  detail: string;
  toolCount: number;
}

export interface CapabilityTool {
  definition: Tool & { function: NonNullable<Tool['function']> };
  risk: CapabilityRisk;
  /** Browser and third-party MCP actions must be approved even in allow mode. */
  alwaysApprove?: boolean;
  approvalDetail(input: unknown): string;
  /** Optional field-aware approval projection. Defaults to the complete tool input. */
  approvalInput?(input: unknown): unknown;
  /** Optional summaries prevent large content or entered credentials reaching the audit log. */
  auditInput?(input: unknown): unknown;
  auditResult?(result: unknown): unknown;
  invoke(input: unknown, context: CapabilityContext): Promise<unknown>;
}

export interface CapabilityAdapter {
  readonly id: string;
  status(workspace?: string): Promise<CapabilityStatus>;
  tools(workspace?: string): Promise<readonly CapabilityTool[]>;
  close?(): Promise<void>;
}

export interface CapabilityAuditEvent {
  taskId: string;
  timestamp: string;
  capability: string;
  tool: string;
  phase: 'requested' | 'approved' | 'denied' | 'completed' | 'failed';
  payload?: unknown;
}

export interface CapabilityApprovalRisk {
  level: CapabilityRisk;
  summary: string;
  reasons: string[];
}

export interface CapabilityApprovalRequest {
  capability: string;
  tool: string;
  detail: string;
  input: unknown;
  risk: CapabilityApprovalRisk;
  /** Session-private HMAC used to scope allow_session without persisting raw secrets. */
  signature: string;
}

export interface CapabilityContext {
  taskId: string;
  workspace: string;
  policy: CapabilityPolicy;
  enabledTools: readonly string[];
  signal?: AbortSignal;
  requestApproval(request: CapabilityApprovalRequest): Promise<ApprovalDecision>;
  audit(event: CapabilityAuditEvent): void | Promise<void>;
}

export class CapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityUnavailableError';
  }
}

export class CapabilityDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityDeniedError';
  }
}

interface RegisteredTool {
  adapter: CapabilityAdapter;
  tool: CapabilityTool;
}

/**
 * One policy, approval, audit and redaction boundary for every optional runtime.
 * Adapters only implement transport-specific work; they cannot bypass this gate.
 */
export class CapabilityRegistry {
  private readonly adapters = new Map<string, CapabilityAdapter>();
  private readonly approvalKey = randomBytes(32);

  register(adapter: CapabilityAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`capability '${adapter.id}' is already registered`);
    this.adapters.set(adapter.id, adapter);
  }

  async statuses(workspace?: string): Promise<CapabilityStatus[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.status(workspace)));
  }

  async definitions(enabledTools?: readonly string[], workspace?: string): Promise<Tool[]> {
    const tools = await this.registeredTools(workspace);
    return tools
      .filter(({ adapter, tool }) => isEnabled(enabledTools, adapter.id, tool.definition.function.name))
      .map(({ tool }) => tool.definition);
  }

  async invoke(name: string, input: unknown, context: CapabilityContext): Promise<unknown> {
    const registered = (await this.registeredTools(context.workspace)).find(({ tool }) => tool.definition.function.name === name);
    if (!registered) throw new CapabilityUnavailableError(`tool '${name}' is unavailable; enable, configure, or connect its integration first`);

    const { adapter, tool } = registered;
    if (!isEnabled(context.enabledTools, adapter.id, name)) {
      throw new CapabilityDeniedError(`tool '${name}' is not enabled for this task`);
    }
    if (context.signal?.aborted) throw abortError();

    const audit = async (phase: CapabilityAuditEvent['phase'], payload?: unknown) => {
      await context.audit({
        taskId: context.taskId,
        timestamp: new Date().toISOString(),
        capability: adapter.id,
        tool: name,
        phase,
        payload: payload === undefined ? undefined : redactValue(payload),
      });
    };

    const auditInput = safeAuditSummary(tool.auditInput, input);
    await audit('requested', { input: auditInput });
    if (context.policy === 'plan' && tool.risk !== 'read') {
      await audit('denied', { reason: 'plan mode does not permit external or mutating tools' });
      throw new CapabilityDeniedError(`tool '${name}' is not permitted in plan mode`);
    }

    try {
      if (tool.alwaysApprove || (context.policy === 'ask' && tool.risk !== 'read')) {
        const detail = tool.approvalDetail(input);
        const approvalInput = boundedApprovalInput(redactValue(safeApprovalInput(tool.approvalInput, input)));
        const request: CapabilityApprovalRequest = {
          capability: adapter.id,
          tool: name,
          detail,
          input: approvalInput,
          risk: {
            level: tool.risk,
            summary: detail,
            reasons: approvalReasons(tool),
          },
          signature: approvalSignature(this.approvalKey, adapter.id, name, input),
        };
        const decision = await context.requestApproval(request);
        if (decision === 'deny') {
          await audit('denied', { decision, signature: request.signature, risk: request.risk });
          throw new CapabilityDeniedError(`user denied '${name}'`);
        }
        await audit('approved', { decision, signature: request.signature, risk: request.risk });
      }

      const result = await tool.invoke(input, context);
      await audit('completed', { result: safeAuditSummary(tool.auditResult, result) });
      return result;
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        await audit('failed', { error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close?.()));
  }

  private async registeredTools(workspace?: string): Promise<RegisteredTool[]> {
    const entries = await Promise.all(
      [...this.adapters.values()].map(async (adapter) => {
        const tools = await adapter.tools(workspace);
        return tools.map((tool) => ({ adapter, tool }));
      }),
    );
    const flattened = entries.flat();
    const names = new Set<string>();
    for (const { tool } of flattened) {
      const name = tool.definition.function.name;
      if (names.has(name)) throw new Error(`duplicate capability tool '${name}'`);
      names.add(name);
    }
    return flattened;
  }
}

function isEnabled(enabled: readonly string[] | undefined, adapterId: string, toolName: string): boolean {
  if (!enabled) return true;
  return enabled.includes(adapterId) || enabled.includes(toolName);
}

const RISK_REASON: Record<CapabilityRisk, string> = {
  read: 'Reads data through an optional capability.',
  write: 'Creates or changes files in the selected project.',
  external: 'Communicates with or acts on an external system.',
};

function approvalReasons(tool: CapabilityTool): string[] {
  const reasons = [RISK_REASON[tool.risk]];
  if (tool.alwaysApprove) reasons.push('This integration requires explicit approval even in allow mode.');
  return reasons;
}

function approvalSignature(key: Buffer, capability: string, tool: string, input: unknown): string {
  return createHmac('sha256', key)
    .update(capability)
    .update('\0')
    .update(tool)
    .update('\0')
    .update(stableInput(input))
    .digest('hex');
}

function stableInput(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'symbol') return `symbol:${value.description ?? ''}`;
  if (typeof value === 'function') return 'function';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableInput(entry, seen)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => `${JSON.stringify(name)}:${stableInput(entry, seen)}`)
    .join(',')}}`;
}
function safeApprovalInput(project: ((value: unknown) => unknown) | undefined, value: unknown): unknown {
  if (!project) return value;
  try {
    return project(value);
  } catch {
    return { error: 'Approval input could not be prepared' };
  }
}

function boundedApprovalInput(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: '[Input could not be serialized]' };
  }
  if (serialized === undefined || Buffer.byteLength(serialized) <= MAX_APPROVAL_INPUT_BYTES) return value;
  const preview = Buffer.from(serialized)
    .subarray(0, MAX_APPROVAL_INPUT_BYTES)
    .toString('utf8');
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized),
    preview,
  };
}


function safeAuditSummary(summarize: ((value: unknown) => unknown) | undefined, value: unknown): unknown {
  if (!summarize) return value;
  try {
    return summarize(value);
  } catch {
    return { summary: 'Input could not be summarized' };
  }
}


function abortError(): Error {
  const error = new Error('capability call cancelled');
  error.name = 'AbortError';
  return error;
}
