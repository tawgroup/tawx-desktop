import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from '../test-support/server.js';
import { createDesktopIntegrationHttpHandler } from './http.js';
import { registerDesktopIntegrations } from './index.js';
import type { McpConnector } from './mcp/client.js';

test('serves restored-workspace integration status and artifact previews without global selection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tawx-integration-http-'));
  const project = join(base, 'project');
  await mkdir(project);
  const auditEvents: unknown[] = [];
  const runtime = registerDesktopIntegrations({
    workspace: () => null,
    mcpConfigPath: join(base, 'mcp.json'),
    audit: (event) => { auditEvents.push(event); },
  });
  const handler = createDesktopIntegrationHttpHandler(runtime.control);
  const server = await startTestServer(async (request, response) => {
    const handled = await handler(request, response, new URL(request.url ?? '/', 'http://desktop.local'));
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });

  try {
    const initialResponse = await fetch(`${server.url}/desktop/integrations?workspace=${encodeURIComponent(project)}`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as { capabilities: Array<{ id: string; available: boolean }> };
    assert.equal(initial.capabilities.find((item) => item.id === 'mcp')?.available, false);

    const configResponse = await fetch(`${server.url}/desktop/integrations/mcp/issues`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'issues',
        name: 'Issues',
        enabled: false,
        transport: { type: 'http', url: 'https://mcp.example.test/mcp' },
      }),
    });
    assert.equal(configResponse.status, 200);
    const configured = await configResponse.json() as { state: string };
    assert.equal(configured.state, 'disabled');

    const created = await runtime.artifacts.store.create(project, { path: 'reports/result.md', content: '# Result' });
    const artifactResponse = await fetch(`${server.url}/desktop/artifacts/${created.id}?workspace=${encodeURIComponent(project)}`);
    assert.equal(artifactResponse.status, 200);
    const artifact = await artifactResponse.json() as typeof created;
    assert.deepEqual(artifact, created);
    assert.equal(artifact.path, 'reports/result.md');
    assert.deepEqual(artifact.preview, { kind: 'text', content: '# Result', truncated: false });
    assert.equal(auditEvents.some((event) => JSON.stringify(event).includes('mcp_configure')), true);
    assert.equal(auditEvents.some((event) => JSON.stringify(event).includes('artifact_read')), true);
  } finally {
    await runtime.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('MCP connect accepts a restored workspace and passes its canonical path to stdio', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tawx-integration-http-'));
  const project = join(base, 'restored-project');
  await mkdir(project);
  let connectedWorkspace: string | null = null;
  const connector: McpConnector = (_config, workspace) => {
    connectedWorkspace = workspace;
    return {
      initialize: async () => ({ serverName: 'Restored server' }),
      listTools: async () => [],
      callTool: async () => ({}),
      close: async () => undefined,
    };
  };
  const runtime = registerDesktopIntegrations({
    workspace: () => null,
    mcpConfigPath: join(base, 'mcp.json'),
    mcpConnector: connector,
    audit: () => undefined,
  });
  const handler = createDesktopIntegrationHttpHandler(runtime.control);
  const server = await startTestServer(async (request, response) => {
    await handler(request, response, new URL(request.url ?? '/', 'http://desktop.local'));
  });
  try {
    const configured = await fetch(`${server.url}/desktop/integrations/mcp/restored`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'restored',
        name: 'Restored stdio',
        enabled: true,
        transport: { type: 'stdio', command: 'node' },
      }),
    });
    assert.equal(configured.status, 200);
    const connected = await fetch(`${server.url}/desktop/integrations/mcp/restored/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: project }),
    });
    assert.equal(connected.status, 200);
    assert.equal(connectedWorkspace, await realpath(project));
  } finally {
    await runtime.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('rejects configuration whose id does not match its route', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tawx-integration-http-'));
  const runtime = registerDesktopIntegrations({
    workspace: () => base,
    mcpConfigPath: join(base, 'mcp.json'),
    audit: () => undefined,
  });
  const handler = createDesktopIntegrationHttpHandler(runtime.control);
  const server = await startTestServer(async (request, response) => {
    await handler(request, response, new URL(request.url ?? '/', 'http://desktop.local'));
  });
  try {
    const response = await fetch(`${server.url}/desktop/integrations/mcp/expected`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'different',
        name: 'Different',
        enabled: false,
        transport: { type: 'http', url: 'https://mcp.example.test/mcp' },
      }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /must match the request path/);
  } finally {
    await runtime.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
