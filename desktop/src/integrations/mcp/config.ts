import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseCommand, redactText } from '../../tools/security.js';
const MAX_CONFIG_BYTES = 512 * 1024;


export interface McpStdioTransport {
  type: 'stdio';
  command: string;
  args?: string[];
  /** Child environment key -> host environment variable name. Host variable values are never persisted. */
  env?: Record<string, string>;
}

export interface McpHttpTransport {
  type: 'http';
  url: string;
  /** HTTP header -> host environment variable name. Host variable values are never persisted. */
  headers?: Record<string, string>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpStdioTransport | McpHttpTransport;
}

interface StoredMcpConfig {
  version: 1;
  servers: McpServerConfig[];
}

export class McpConfigStore {
  private updateQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly path = join(homedir(), '.tawx', 'mcp-servers.json')) {}

  async list(): Promise<McpServerConfig[]> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) {
        throw new Error('MCP configuration is not a safe regular file');
      }
      const parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('MCP configuration has an unsupported format');
      }
      const document = parsed as Record<string, unknown>;
      if (document.version !== 1) throw new Error('MCP configuration has an unsupported format');
      if (!Array.isArray(document.servers)) throw new Error('MCP configuration is missing servers');
      const servers = document.servers.map(validateMcpServerConfig);
      const ids = new Set<string>();
      for (const server of servers) {
        if (ids.has(server.id)) throw new Error(`MCP configuration contains duplicate server '${server.id}'`);
        ids.add(server.id);
      }
      return servers;
    } catch (error) {
      if (isMissing(error)) return [];
      if (isSymlink(error)) throw new Error('MCP configuration is not a safe regular file');
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async set(input: unknown): Promise<McpServerConfig> {
    const validated = validateMcpServerConfig(input);
    const operation = this.updateQueue.then(async () => {
      const servers = await this.list();
      const index = servers.findIndex((server) => server.id === validated.id);
      if (index === -1) servers.push(validated);
      else servers[index] = validated;
      await this.save(servers);
      return validated;
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  async remove(id: string): Promise<boolean> {
    validateId(id);
    const operation = this.updateQueue.then(async () => {
      const servers = await this.list();
      const remaining = servers.filter((server) => server.id !== id);
      if (remaining.length === servers.length) return false;
      await this.save(remaining);
      return true;
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  private async save(servers: McpServerConfig[]): Promise<void> {
    const data: StoredMcpConfig = { version: 1, servers };
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new Error('MCP configuration exceeds the size limit');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function validateMcpServerConfig(input: unknown): McpServerConfig {
  if (!input || typeof input !== 'object') throw new Error('MCP server configuration must be an object');
  const record = input as Record<string, unknown>;
  const id = requiredString(record, 'id');
  validateId(id);
  const name = requiredString(record, 'name');
  if (name.length > 100) throw new Error('MCP server name exceeds 100 characters');
  if (typeof record.enabled !== 'boolean') throw new Error("MCP server 'enabled' must be a boolean");
  const transport = validateTransport(record.transport);
  return { id, name, enabled: record.enabled, transport };
}

function validateTransport(input: unknown): McpStdioTransport | McpHttpTransport {
  if (!input || typeof input !== 'object') throw new Error('MCP transport must be an object');
  const record = input as Record<string, unknown>;
  if (record.type === 'stdio') {
    const command = requiredString(record, 'command');
    if (command.length > 500) throw new Error('MCP command exceeds 500 characters');
    if (command.includes('\0')) throw new Error('MCP command contains a null byte');
    const executable = parseCommand(JSON.stringify(command)).executable;
    const args = optionalStringArray(record.args, 'MCP arguments');
    if (args?.some((argument, index) => (
      argument.includes('\0')
      || redactText(argument) !== argument
      || (/^--?(?:api[-_]?key|auth|authorization|password|secret|token)$/i.test(argument) && index + 1 < args.length)
    ))) {
      throw new Error('MCP arguments must reference credentials through configured environment variables');
    }
    const env = optionalReferences(record.env, 'environment');
    return { type: 'stdio', command: executable, args, env };
  }
  if (record.type === 'http') {
    const rawUrl = requiredString(record, 'url');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('MCP HTTP URL must be absolute');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('MCP HTTP URL must use HTTP or HTTPS');
    if ([...url.searchParams.keys()].some((key) => /(?:^|[_-])(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token)(?:$|[_-])/i.test(key))) {
      throw new Error('MCP URL credentials must use an environment-backed header');
    }
    if (url.username || url.password) throw new Error('MCP HTTP URL must not contain credentials');
    const headers = optionalReferences(record.headers, 'header');
    return { type: 'http', url: url.href, headers };
  }
  throw new Error("MCP transport type must be 'stdio' or 'http'");
}

function optionalStringArray(input: unknown, label: string): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.some((item) => typeof item !== 'string')) throw new Error(`${label} must be strings`);
  if (input.length > 100 || input.some((item) => item.length > 1_000)) throw new Error(`${label} exceed the supported size`);
  return [...input];
}

const RESERVED_HTTP_HEADERS: Record<string, true> = {
  accept: true,
  connection: true,
  'content-length': true,
  'content-type': true,
  host: true,
  'mcp-protocol-version': true,
  'mcp-session-id': true,
  'transfer-encoding': true,
};

function optionalReferences(input: unknown, label: string): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`MCP ${label} references must be an object`);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(key) || typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(`invalid MCP ${label} environment reference`);
    }
    if (label === 'header' && RESERVED_HTTP_HEADERS[key.toLowerCase()]) {
      throw new Error(`MCP header '${key}' is managed by the client`);
    }
    if (label === 'environment' && /^(?:BASH_ENV|CDPATH|ENV|GIT_|LD_|DYLD_|NODE_OPTIONS|SHELLOPTS|SSH_)/i.test(key)) {
      throw new Error(`MCP child environment key '${key}' is not allowed`);
    }
    output[key] = value;
  }
  return output;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`MCP server '${key}' must be a string`);
  return value.trim();
}

function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error('MCP server id must contain only lowercase letters, numbers, hyphens, or underscores');
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isSymlink(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP');
}
