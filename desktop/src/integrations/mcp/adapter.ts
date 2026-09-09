import { isAbsolute } from 'node:path';
import { redactSensitiveText, type CapabilityAdapter, type CapabilityContext, type CapabilityStatus, type CapabilityTool } from '../capabilities.js';
import { McpConfigStore, type McpServerConfig } from './config.js';
import {
  createMcpConnection,
  type McpConnection,
  type McpConnector,
  type McpRemoteTool,
} from './client.js';

export interface McpServerStatus {
  config: McpServerConfig;
  state: 'disabled' | 'disconnected' | 'connected' | 'error';
  detail: string;
  tools: string[];
}

interface ActiveServer {
  id: string;
  fingerprint: string;
  workspace: string;
  connection: McpConnection;
  serverName: string;
  tools: McpRemoteTool[];
}

export class McpAdapter implements CapabilityAdapter {
  readonly id = 'mcp';
  private readonly active = new Map<string, ActiveServer>();
  private readonly errors = new Map<string, string>();
  private readonly connecting = new Map<string, Promise<ActiveServer>>();

  constructor(
    readonly config: McpConfigStore,
    private readonly workspace: () => string | null,
    private readonly connector: McpConnector = createMcpConnection,
  ) {}

  async status(workspaceOverride?: string): Promise<CapabilityStatus> {
    let servers: McpServerConfig[];
    try {
      servers = await this.config.list();
    } catch (error) {
      return {
        id: this.id,
        name: 'Apps & MCP',
        available: false,
        configured: false,
        detail: `MCP configuration could not be read: ${messageOf(error)}`,
        toolCount: 0,
      };
    }
    const workspace = workspaceOverride ?? this.workspace();
    const enabled = servers.filter((server) => server.enabled);
    const toolCount = enabled.reduce((count, server) => count + (this.activeFor(server, workspace)?.tools.length ?? 0), 0);
    const connected = enabled.filter((server) => this.activeFor(server, workspace));
    if (servers.length === 0) {
      return {
        id: this.id,
        name: 'Apps & MCP',
        available: false,
        configured: false,
        detail: 'Add a stdio or HTTP MCP server to expose its tools.',
        toolCount: 0,
      };
    }
    if (enabled.length === 0) {
      return {
        id: this.id,
        name: 'Apps & MCP',
        available: false,
        configured: true,
        detail: 'All configured MCP servers are disabled. Enable one to expose its tools.',
        toolCount: 0,
      };
    }
    if (!workspace && enabled.every((server) => server.transport.type === 'stdio')) {
      return {
        id: this.id,
        name: 'Apps & MCP',
        available: false,
        configured: true,
        detail: 'Select a project before connecting a stdio MCP server.',
        toolCount: 0,
      };
    }
    const failed = enabled.filter((server) => this.errorFor(server, workspace));
    return {
      id: this.id,
      name: 'Apps & MCP',
      available: connected.length > 0,
      configured: true,
      detail: connected.length > 0
        ? `${connected.length} server${connected.length === 1 ? '' : 's'} connected with ${toolCount} tool${toolCount === 1 ? '' : 's'}${failed.length > 0 ? `; ${failed.length} connection attempt failed` : ''}.`
        : failed.length > 0
          ? `${failed.length} of ${enabled.length} enabled MCP servers failed to connect. Open integrations for details.`
          : `${enabled.length} server${enabled.length === 1 ? '' : 's'} configured. Connect to discover tools.`,
      toolCount,
    };
  }

  async tools(workspaceOverride?: string): Promise<readonly CapabilityTool[]> {
    let configs: McpServerConfig[];
    try {
      configs = (await this.config.list()).filter((server) => server.enabled);
    } catch {
      return [];
    }
    const workspace = workspaceOverride ?? this.workspace();
    return configs.flatMap((config) => {
      const server = this.activeFor(config, workspace);
      return server ? this.capabilityTools(server) : [];
    });
  }

  async listServers(workspaceOverride = this.workspace()): Promise<McpServerStatus[]> {
    const configs = await this.config.list();
    return configs.map((config) => {
      if (!config.enabled) {
        return { config, state: 'disabled', detail: 'Disabled', tools: [] };
      }
      const active = this.activeFor(config, workspaceOverride);
      if (active) {
        return {
          config,
          state: 'connected',
          detail: `Connected to ${active.serverName}`,
          tools: active.tools.map((tool) => tool.name),
        };
      }
      const error = this.errorFor(config, workspaceOverride);
      return error
        ? { config, state: 'error', detail: error, tools: [] }
        : { config, state: 'disconnected', detail: 'Not connected', tools: [] };
    });
  }

  async configure(input: unknown): Promise<McpServerStatus> {
    const saved = await this.config.set(input);
    await this.disconnect(saved.id);
    const [status] = (await this.listServers()).filter((server) => server.config.id === saved.id);
    if (!status) throw new Error(`MCP server '${saved.id}' was not saved`);
    return status;
  }

  async remove(id: string): Promise<boolean> {
    await this.disconnect(id);
    return this.config.remove(id);
  }

  async connect(id: string, workspace = this.workspace() ?? ''): Promise<McpServerStatus> {
    await this.ensureConnected(id, workspace);
    const status = (await this.listServers(workspace)).find((server) => server.config.id === id);
    if (!status) throw new Error(`MCP server '${id}' is not configured`);
    return status;
  }

  async close(): Promise<void> {
    await Promise.all([...this.active.values()].map((server) => server.connection.close()));
    this.active.clear();
    this.errors.clear();
  }

  private async ensureConnected(id: string, workspace: string): Promise<ActiveServer> {
    const config = (await this.config.list()).find((candidate) => candidate.id === id);
    if (!config) throw new Error(`MCP server '${id}' is not configured`);
    if (!config.enabled) throw new Error(`MCP server '${id}' is disabled`);
    if (config.transport.type === 'stdio' && !isAbsolute(workspace)) {
      throw new Error('Select a project before connecting this stdio server.');
    }
    const scopedWorkspace = config.transport.type === 'stdio' ? workspace : '';
    const key = connectionKey(id, scopedWorkspace);
    const pending = this.connecting.get(key);
    if (pending) return pending;
    const promise = this.connectNow(config, scopedWorkspace, key).finally(() => this.connecting.delete(key));
    this.connecting.set(key, promise);
    return promise;
  }

  private async connectNow(config: McpServerConfig, workspace: string, key: string): Promise<ActiveServer> {
    const fingerprint = JSON.stringify(config);
    const existing = this.active.get(key);
    if (existing && existing.fingerprint === fingerprint) return existing;
    if (existing) {
      this.active.delete(key);
      await existing.connection.close();
    }

    const connection = this.connector(config, workspace);
    try {
      const { serverName } = await connection.initialize();
      const tools = await connection.listTools();
      assertUniqueToolNames(config.id, tools);
      const active = { id: config.id, fingerprint, workspace, connection, serverName, tools };
      this.active.set(key, active);
      this.errors.delete(key);
      return active;
    } catch (error) {
      await connection.close();
      this.errors.set(key, actionableConnectionError(config, error));
      throw error;
    }
  }

  private async disconnect(id: string): Promise<void> {
    const matches = [...this.active.entries()].filter(([, server]) => server.id === id);
    for (const [key, server] of matches) {
      this.active.delete(key);
      await server.connection.close();
    }
    for (const key of [...this.errors.keys()]) {
      if (key.startsWith(`${id}\0`)) this.errors.delete(key);
    }
  }

  private activeFor(config: McpServerConfig, workspace: string | null | undefined): ActiveServer | undefined {
    const scopedWorkspace = config.transport.type === 'stdio' ? workspace : '';
    return scopedWorkspace === null || scopedWorkspace === undefined
      ? undefined
      : this.active.get(connectionKey(config.id, scopedWorkspace));
  }

  private errorFor(config: McpServerConfig, workspace: string | null | undefined): string | undefined {
    const scopedWorkspace = config.transport.type === 'stdio' ? workspace : '';
    return scopedWorkspace === null || scopedWorkspace === undefined
      ? undefined
      : this.errors.get(connectionKey(config.id, scopedWorkspace));
  }

  private capabilityTools(server: ActiveServer): CapabilityTool[] {
    const serverId = server.id;
    return server.tools.map((remoteTool) => {
      const toolName = mcpToolName(serverId, remoteTool.name);
      return {
        definition: {
          type: 'function',
          function: {
            name: toolName,
            description: remoteTool.description
              ? `${remoteTool.description} (via MCP server ${server.serverName})`
              : `Call ${remoteTool.name} via MCP server ${server.serverName}.`,
            parameters: remoteTool.inputSchema,
          },
        },
        risk: 'external',
        alwaysApprove: true,
        approvalDetail: () => `Call ${remoteTool.name} on MCP server ${server.serverName}`,
        auditInput: () => ({ server: server.serverName, remoteTool: remoteTool.name, arguments: '[REDACTED]' }),
        auditResult: (result: unknown) => ({
          server: server.serverName,
          remoteTool: remoteTool.name,
          resultType: Array.isArray(result) ? 'array' : typeof result,
        }),
        invoke: async (input: unknown, context: CapabilityContext) => {
          const id = serverId;
          const current = await this.ensureConnected(id, context.workspace);
          if (!current.tools.some((candidate) => candidate.name === remoteTool.name)) {
            throw new Error('MCP server tool list changed; retry the request');
          }
          return current.connection.callTool(remoteTool.name, input, context.signal);
        },
      };
    });
  }

}

function mcpToolName(serverId: string, remoteToolName: string): string {
  return `mcp__${safeToolSegment(serverId)}__${safeToolSegment(remoteToolName)}`.slice(0, 64);
}

function safeToolSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'tool';
}

function assertUniqueToolNames(serverId: string, tools: McpRemoteTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = mcpToolName(serverId, tool.name);
    if (names.has(name)) throw new Error(`MCP server exposes colliding tool names after normalization: '${name}'`);
    names.add(name);
  }
}


function connectionKey(serverId: string, workspace: string): string {
  return `${serverId}\0${workspace}`;
}

function actionableConnectionError(config: McpServerConfig, error: unknown): string {
  const prefix = config.transport.type === 'stdio'
    ? `Could not start '${config.transport.command}'`
    : `Could not connect to ${new URL(config.transport.url).origin}`;
  return `${prefix}: ${messageOf(error)}. Check the command/URL and referenced environment variables.`;
}

function messageOf(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
