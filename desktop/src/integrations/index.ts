import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ArtifactAdapter } from '../artifacts/adapter.js';
import type { ArtifactMetadata, ArtifactPreview } from '../artifacts/store.js';
import { Workspace } from '../tools/workspace.js';
import { BrowserAdapter, type BrowserSessionFactory } from './browser.js';
import {
  CapabilityRegistry,
  redactSensitive,
  type CapabilityAuditEvent,
  type CapabilityStatus,
} from './capabilities.js';
import { McpAdapter, type McpServerStatus } from './mcp/adapter.js';
import type { McpConnector } from './mcp/client.js';
import { McpConfigStore } from './mcp/config.js';

export * from './capabilities.js';
export * from './browser.js';
export * from './http.js';
export * from './mcp/adapter.js';
export * from './mcp/client.js';
export * from './mcp/config.js';
export * from '../artifacts/adapter.js';
export * from '../artifacts/store.js';

export interface IntegrationControlAuditEvent {
  timestamp: string;
  operation: 'mcp_configure' | 'mcp_connect' | 'mcp_remove' | 'artifact_list' | 'artifact_read';
  phase: 'requested' | 'completed' | 'failed';
  payload?: unknown;
}

export interface DesktopIntegrationRuntimeOptions {
  workspace(): string | null;
  audit(event: IntegrationControlAuditEvent | CapabilityAuditEvent): void | Promise<void>;
  mcpConfigPath?: string;
  browserSessionFactory?: BrowserSessionFactory;
  mcpConnector?: McpConnector;
}

export interface IntegrationSnapshot {
  capabilities: CapabilityStatus[];
  mcpServers: McpServerStatus[];
}

export class IntegrationControl {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly mcp: McpAdapter,
    private readonly artifacts: ArtifactAdapter,
    private readonly workspace: () => string | null,
    private readonly audit: DesktopIntegrationRuntimeOptions['audit'],
  ) {}

  async snapshot(workspacePath?: string): Promise<IntegrationSnapshot> {
    const workspace = await this.resolveWorkspace(workspacePath, false);
    return {
      capabilities: await this.registry.statuses(workspace ?? undefined),
      mcpServers: await this.mcp.listServers(workspace),
    };
  }

  async configureMcp(input: unknown): Promise<McpServerStatus> {
    const summary = mcpConfigSummary(input);
    return this.audited('mcp_configure', summary, () => this.mcp.configure(input));
  }

  async connectMcp(id: string, workspacePath?: string): Promise<McpServerStatus> {
    return this.audited('mcp_connect', { id, workspace: workspacePath }, async () => {
      const workspace = await this.resolveWorkspace(workspacePath, false);
      return this.mcp.connect(id, workspace ?? '');
    });
  }

  async removeMcp(id: string): Promise<{ removed: boolean }> {
    return this.audited('mcp_remove', { id }, async () => ({ removed: await this.mcp.remove(id) }));
  }

  async listArtifacts(workspacePath?: string): Promise<ArtifactMetadata[]> {
    return this.audited(
      'artifact_list',
      { workspace: workspacePath },
      async () => this.artifacts.store.list(await this.resolveWorkspace(workspacePath, true)),
      (result) => ({ count: result.length }),
    );
  }

  async readArtifact(id: string, workspacePath?: string): Promise<ArtifactPreview> {
    return this.audited(
      'artifact_read',
      { id, workspace: workspacePath },
      async () => this.artifacts.store.read(await this.resolveWorkspace(workspacePath, true), id),
      (result) => ({ id: result.id, path: result.path, size: result.size, previewKind: result.preview.kind }),
    );
  }

  private resolveWorkspace(workspacePath: string | undefined, required: true): Promise<string>;
  private resolveWorkspace(workspacePath: string | undefined, required: false): Promise<string | null>;
  private async resolveWorkspace(workspacePath: string | undefined, required: boolean): Promise<string | null> {
    const candidate = workspacePath ?? this.workspace();
    if (!candidate) {
      if (required) throw new Error('Select a project to view artifacts.');
      return null;
    }
    if (!isAbsolute(candidate)) throw new Error('Workspace path must be absolute.');
    const workspace = new Workspace();
    const canonical = await workspace.select(candidate);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace path must be a project directory.');
    return canonical;
  }

  private async audited<T>(
    operation: IntegrationControlAuditEvent['operation'],
    payload: unknown,
    action: () => Promise<T>,
    resultSummary: (result: T) => unknown = () => ({}),
  ): Promise<T> {
    const emit = async (phase: IntegrationControlAuditEvent['phase'], detail: unknown) => {
      await this.audit({
        timestamp: new Date().toISOString(),
        operation,
        phase,
        payload: redactSensitive(detail),
      });
    };
    await emit('requested', payload);
    try {
      const result = await action();
      await emit('completed', resultSummary(result));
      return result;
    } catch (error) {
      await emit('failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

export interface DesktopIntegrationRuntime {
  capabilities: CapabilityRegistry;
  control: IntegrationControl;
  browser: BrowserAdapter;
  mcp: McpAdapter;
  artifacts: ArtifactAdapter;
  close(): Promise<void>;
}

/** Registers all optional capabilities once for both the agent loop and /desktop control routes. */
export function registerDesktopIntegrations(options: DesktopIntegrationRuntimeOptions): DesktopIntegrationRuntime {
  const registry = new CapabilityRegistry();
  const browser = new BrowserAdapter(options.browserSessionFactory);
  const mcp = new McpAdapter(new McpConfigStore(options.mcpConfigPath), options.workspace, options.mcpConnector);
  const artifacts = new ArtifactAdapter();
  registry.register(browser);
  registry.register(mcp);
  registry.register(artifacts);
  const control = new IntegrationControl(registry, mcp, artifacts, options.workspace, options.audit);
  return {
    capabilities: registry,
    control,
    browser,
    mcp,
    artifacts,
    close: () => registry.close(),
  };
}

function mcpConfigSummary(input: unknown): unknown {
  if (!input || typeof input !== 'object') return { invalid: true };
  const record = input as Record<string, unknown>;
  const transport = record.transport && typeof record.transport === 'object'
    ? record.transport as Record<string, unknown>
    : {};
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    transport: transport.type,
    target: transport.type === 'http' && typeof transport.url === 'string'
      ? safeHttpOrigin(transport.url)
      : transport.type === 'stdio'
        ? transport.command
        : undefined,
    environmentReferences: transport.env && typeof transport.env === 'object' ? Object.keys(transport.env) : undefined,
    headerReferences: transport.headers && typeof transport.headers === 'object' ? Object.keys(transport.headers) : undefined,
  };
}

function safeHttpOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid URL';
  }
}
