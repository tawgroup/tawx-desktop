import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityRegistry,
  type CapabilityApprovalRequest,
  type CapabilityAuditEvent,
  type CapabilityContext,
} from '../capabilities.js';
import { McpAdapter } from './adapter.js';
import type { McpConnection, McpConnector } from './client.js';
import { McpConfigStore } from './config.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'tawx-mcp-'));
  return {
    base,
    configPath: join(base, 'mcp.json'),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function fakeConnector(calls: unknown[]): McpConnector {
  return (_config, workspace): McpConnection => ({
    initialize: async () => ({ serverName: 'Issue tracker' }),
    listTools: async () => [{
      name: 'create_issue',
      description: 'Create an issue',
      inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
    }],
    callTool: async (name, args) => {
      calls.push({ name, args, workspace });
      return { content: [{ type: 'text', text: 'Created issue 42' }] };
    },
    close: async () => undefined,
  });
}

test('connected MCP server discovers and invokes real remote tools through approval', async () => {
  const fx = await fixture();
  try {
    const calls: unknown[] = [];
    const adapter = new McpAdapter(new McpConfigStore(fx.configPath), () => fx.base, fakeConnector(calls));
    await adapter.configure({
      id: 'issues',
      name: 'Issues',
      enabled: true,
      transport: { type: 'http', url: 'https://mcp.example.test/', headers: { Authorization: 'MCP_TEST_TOKEN' } },
    });
    await adapter.connect('issues');
    const definitions = await adapter.tools();
    assert.deepEqual(definitions.map((tool) => tool.definition.function.name), ['mcp__issues__create_issue']);

    const registry = new CapabilityRegistry();
    registry.register(adapter);
    const events: CapabilityAuditEvent[] = [];
    let approval: CapabilityApprovalRequest | undefined;
    const context: CapabilityContext = {
      taskId: 'mcp-task',
      workspace: fx.base,
      policy: 'allow',
      enabledTools: ['mcp'],
      requestApproval: async (request) => { approval = request; return 'allow_once'; },
      audit: (event) => { events.push(event); },
    };
    const result = await registry.invoke('mcp__issues__create_issue', { title: 'Broken build', token: 'do-not-log' }, context);

    assert.deepEqual(result, { content: [{ type: 'text', text: 'Created issue 42' }] });
    assert.deepEqual(approval?.input, { title: 'Broken build', token: '[REDACTED]' });
    assert.deepEqual(calls, [{ name: 'create_issue', args: { title: 'Broken build', token: 'do-not-log' }, workspace: '' }]);
    assert.equal(JSON.stringify(events).includes('do-not-log'), false);
    assert.equal(JSON.stringify(events).includes('Created issue 42'), false);
  } finally {
    await fx.cleanup();
  }
});
test('stdio MCP discovery is scoped to the task workspace', async () => {
  const fx = await fixture();
  const workspaceA = join(fx.base, 'workspace-a');
  const workspaceB = join(fx.base, 'workspace-b');
  const connector: McpConnector = (_config, workspace) => ({
    initialize: async () => ({ serverName: `Server ${workspace}` }),
    listTools: async () => [{
      name: workspace === workspaceA ? 'workspace_a' : 'workspace_b',
      inputSchema: { type: 'object', properties: {} },
    }],
    callTool: async () => ({ workspace }),
    close: async () => undefined,
  });
  const adapter = new McpAdapter(new McpConfigStore(fx.configPath), () => workspaceA, connector);
  try {
    await adapter.configure({
      id: 'scoped',
      name: 'Scoped tools',
      enabled: true,
      transport: { type: 'stdio', command: 'node' },
    });
    await adapter.connect('scoped', workspaceA);

    assert.deepEqual((await adapter.tools(workspaceA)).map((tool) => tool.definition.function.name), ['mcp__scoped__workspace_a']);
    assert.deepEqual(await adapter.tools(workspaceB), []);
    assert.equal((await adapter.status(workspaceA)).available, true);
    assert.equal((await adapter.status(workspaceB)).available, false);

    await adapter.connect('scoped', workspaceB);
    assert.deepEqual((await adapter.tools(workspaceB)).map((tool) => tool.definition.function.name), ['mcp__scoped__workspace_b']);
    assert.deepEqual((await adapter.tools(workspaceA)).map((tool) => tool.definition.function.name), ['mcp__scoped__workspace_a']);
  } finally {
    await adapter.close();
    await fx.cleanup();
  }
});


test('MCP configuration stores environment references, never secret values', async () => {
  const fx = await fixture();
  try {
    const store = new McpConfigStore(fx.configPath);
    await store.set({
      id: 'local',
      name: 'Local tools',
      enabled: true,
      transport: { type: 'stdio', command: 'mcp-server', env: { API_TOKEN: 'TAWX_TEST_SECRET' } },
    });
    const persisted = await readFile(fx.configPath, 'utf8');
    assert.match(persisted, /TAWX_TEST_SECRET/);
    assert.equal(persisted.includes('actual-secret-value'), false);
    await assert.rejects(
      () => store.set({
        id: 'bad',
        name: 'Bad server',
        enabled: true,
        transport: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer actual-secret-value' } },
      }),
      /environment reference/,
    );
    await assert.rejects(
      () => store.set({
        id: 'shell',
        name: 'Unsafe shell',
        enabled: true,
        transport: { type: 'stdio', command: 'bash', args: ['-c', 'server'] },
      }),
      /not allowed/,
    );
    await assert.rejects(
      () => store.set({
        id: 'argument_secret',
        name: 'Argument secret',
        enabled: true,
        transport: { type: 'stdio', command: 'node', args: ['server.js', '--token', 'actual-secret-value'] },
      }),
      /environment variables/,
    );
    assert.equal((await readFile(fx.configPath, 'utf8')).includes('actual-secret-value'), false);
  } finally {
    await fx.cleanup();
  }
});

test('MCP configuration rejects symlinks and oversized files', async () => {
  const symlinkFixture = await fixture();
  try {
    const target = join(symlinkFixture.base, 'outside.json');
    await writeFile(target, '{\"version\":1,\"servers\":[]}');
    await symlink(target, symlinkFixture.configPath);
    await assert.rejects(() => new McpConfigStore(symlinkFixture.configPath).list(), /safe regular file/);
  } finally {
    await symlinkFixture.cleanup();
  }

  const oversizedFixture = await fixture();
  try {
    await writeFile(oversizedFixture.configPath, 'x'.repeat(512 * 1024 + 1));
    await assert.rejects(() => new McpConfigStore(oversizedFixture.configPath).list(), /safe regular file/);
  } finally {
    await oversizedFixture.cleanup();
  }
});

test('unconfigured MCP adapter is honestly unavailable with setup guidance', async () => {
  const fx = await fixture();
  try {
    const adapter = new McpAdapter(new McpConfigStore(fx.configPath), () => fx.base, fakeConnector([]));
    const status = await adapter.status();
    assert.equal(status.available, false);
    assert.equal(status.configured, false);
    assert.match(status.detail, /Add a stdio or HTTP MCP server/);
    assert.deepEqual(await adapter.tools(), []);
  } finally {
    await fx.cleanup();
  }
});
