import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { commandEnvironment } from '../../tools/security.js';
import type { McpHttpTransport, McpServerConfig, McpStdioTransport } from './config.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 5_000_000;

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpConnection {
  initialize(signal?: AbortSignal): Promise<{ serverName: string }>;
  listTools(signal?: AbortSignal): Promise<McpRemoteTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export type McpConnector = (config: McpServerConfig, workspace: string) => McpConnection;

export function createMcpConnection(config: McpServerConfig, workspace: string): McpConnection {
  if (config.transport.type === 'stdio') return new StdioMcpConnection(config.transport, workspace);
  return new HttpMcpConnection(config.transport);
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

class StdioMcpConnection implements McpConnection {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    cleanup: () => void;
  }>();
  private nextId = 1;
  private buffer = '';
  private initialized = false;
  private closedError: Error | null = null;

  constructor(transport: McpStdioTransport, workspace: string) {
    const env = resolveEnvironment(transport.env);
    this.process = spawn(transport.command, transport.args ?? [], {
      cwd: workspace,
      env: { ...commandEnvironment(workspace), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Drain stderr so a noisy server cannot block. It is deliberately not logged: it may contain credentials.
    this.process.stderr.resume();
    this.process.on('error', (error) => this.terminate(new Error(`MCP server failed to start: ${error.message}`)));
    this.process.on('exit', (code, signal) => {
      this.terminate(new Error(`MCP server exited (${signal ?? `code ${code ?? 'unknown'}`})`));
    });
  }

  async initialize(signal?: AbortSignal): Promise<{ serverName: string }> {
    if (this.initialized) return { serverName: 'MCP server' };
    const result = asRecord(await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tawx-desktop', version: '0.1.0' },
    }, signal));
    const serverName = readServerName(result.serverInfo);
    this.notify('notifications/initialized', {});
    this.initialized = true;
    return { serverName };
  }
  async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
    await this.initialize(signal);
    return listAllTools((params) => this.request('tools/list', params, signal));
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.initialize(signal);
    return this.request('tools/call', { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    this.terminate(new Error('MCP connection closed'));
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        request.cleanup();
        this.pending.delete(id);
        request.reject(abortError());
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        cleanup();
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: unknown): void {
    if (this.closedError) throw this.closedError;
    const serialized = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) throw new Error('MCP request exceeds the message limit');
    this.process.stdin.write(serialized);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.terminate(new Error('MCP response exceeds the message limit'));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.terminate(new Error('MCP server returned invalid JSON'));
        return;
      }
      if (typeof message.id !== 'number') continue;
      const request = this.pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timer);
      request.cleanup();
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? 'unknown'}`));
      else request.resolve(message.result);
    }
  }

  private terminate(error: Error): void {
    if (!this.closedError) this.closedError = error;
    this.failAll(this.closedError);
    if (!this.process.killed) this.process.kill('SIGTERM');
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }
}

class HttpMcpConnection implements McpConnection {
  private sessionId: string | null = null;
  private initialized = false;

  constructor(private readonly transport: McpHttpTransport) {}

  async initialize(signal?: AbortSignal): Promise<{ serverName: string }> {
    if (this.initialized) return { serverName: 'MCP server' };
    const result = asRecord(await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'tawx-desktop', version: '0.1.0' },
    }, signal));
    await this.notification('notifications/initialized', {}, signal);
    this.initialized = true;
    return { serverName: readServerName(result.serverInfo) };
  }

  async listTools(signal?: AbortSignal): Promise<McpRemoteTool[]> {
    await this.initialize(signal);
    return listAllTools((params) => this.request('tools/list', params, signal));
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.initialize(signal);
    return this.request('tools/call', { name, arguments: args }, signal);
  }

  async close(): Promise<void> {
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.initialized = false;
    if (!sessionId) return;
    try {
      await fetch(this.transport.url, {
        method: 'DELETE',
        headers: {
          ...resolveEnvironment(this.transport.headers),
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          'Mcp-Session-Id': sessionId,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      // Session cleanup is best effort; the server is responsible for expiring abandoned sessions.
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = crypto.randomUUID();
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    if (response.error) throw new Error(response.error.message ?? `MCP error ${response.error.code ?? 'unknown'}`);
    return response.result;
  }

  private async notification(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, signal, true);
  }

  private async post(payload: unknown, signal?: AbortSignal, notification = false): Promise<JsonRpcResponse> {
    const environmentHeaders = resolveEnvironment(this.transport.headers);
    const headers: Record<string, string> = {
      ...environmentHeaders,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const response = await fetch(this.transport.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: withTimeout(signal),
      redirect: 'error',
    });
    const responseSession = response.headers.get('mcp-session-id');
    if (responseSession) this.sessionId = responseSession;
    if (notification && response.status === 202) return { jsonrpc: '2.0' };
    if (!response.ok) throw new Error(`MCP HTTP server returned ${response.status}`);
    const body = await readBoundedBody(response);
    const contentType = response.headers.get('content-type') ?? '';
    const candidate = contentType.includes('text/event-stream') ? parseSseResponse(body) : body;
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(candidate) as JsonRpcResponse;
    } catch {
      throw new Error('MCP HTTP server returned invalid JSON');
    }
    return parsed;
  }
}

function resolveEnvironment(references?: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [target, source] of Object.entries(references ?? {})) {
    const value = process.env[source];
    if (value === undefined) throw new Error(`required environment variable '${source}' is not set`);
    resolved[target] = value;
  }
  return resolved;
}

async function listAllTools(request: (params: Record<string, string>) => Promise<unknown>): Promise<McpRemoteTool[]> {
  const tools: McpRemoteTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = asRecord(await request(cursor ? { cursor } : {}));
    tools.push(...parseTools(result.tools));
    if (tools.length > 500) throw new Error('MCP server exposes more than 500 tools');
    if (typeof result.nextCursor !== 'string' || result.nextCursor === '') return tools;
    if (cursors.has(result.nextCursor)) throw new Error('MCP server returned a repeated tools cursor');
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error('MCP tools list exceeds 20 pages');
}

function parseTools(input: unknown): McpRemoteTool[] {
  if (!Array.isArray(input)) throw new Error('MCP tools/list response is missing tools');
  return input.map((candidate) => {
    const record = asRecord(candidate);
    if (typeof record.name !== 'string' || record.name.trim() === '') throw new Error('MCP tool is missing a name');
    return {
      name: record.name,
      description: typeof record.description === 'string' ? record.description : undefined,
      inputSchema: record.inputSchema && typeof record.inputSchema === 'object'
        ? record.inputSchema
        : { type: 'object', properties: {} },
    };
  });
}

function readServerName(serverInfo: unknown): string {
  if (!serverInfo || typeof serverInfo !== 'object' || Array.isArray(serverInfo)) return 'MCP server';
  const name = (serverInfo as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim() ? name : 'MCP server';
}

function asRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP server returned an invalid response');
  return input as Record<string, unknown>;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_MESSAGE_BYTES) {
      await reader.cancel();
      throw new Error('MCP response exceeds the message limit');
    }
    body += decoder.decode(next.value, { stream: true });
  }
  return body + decoder.decode();
}

function parseSseResponse(body: string): string {
  const events = body.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data !== '') return data;
  }
  throw new Error('MCP HTTP server returned an empty event stream');
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(): Error {
  const error = new Error('MCP request cancelled');
  error.name = 'AbortError';
  return error;
}
