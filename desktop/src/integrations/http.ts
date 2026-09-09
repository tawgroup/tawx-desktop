import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IntegrationControl } from './index.js';

const MAX_CONFIG_BYTES = 1_000_000;

export type DesktopHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => Promise<boolean>;

/** Same-origin JSON routes for integration configuration and artifact previews. */
export function createDesktopIntegrationHttpHandler(control: IntegrationControl): DesktopHttpHandler {
  return async (request, response, url) => {
    try {
      if (url.pathname === '/desktop/integrations') {
        if (!requireMethod(request, response, 'GET')) return true;
        sendJson(response, 200, await control.snapshot(workspaceFromQuery(url)));
        return true;
      }
      if (url.pathname === '/desktop/artifacts') {
        if (!requireMethod(request, response, 'GET')) return true;
        sendJson(response, 200, await control.listArtifacts(workspaceFromQuery(url)));
        return true;
      }

      const artifactMatch = /^\/desktop\/artifacts\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (artifactMatch) {
        if (!requireMethod(request, response, 'GET')) return true;
        sendJson(response, 200, await control.readArtifact(artifactMatch[1] ?? '', workspaceFromQuery(url)));
        return true;
      }

      const connectMatch = /^\/desktop\/integrations\/mcp\/([a-z0-9][a-z0-9_-]{0,63})\/connect$/.exec(url.pathname);
      if (connectMatch) {
        if (!requireMethod(request, response, 'POST')) return true;
        const input = await readJson(request, false);
        sendJson(response, 200, await control.connectMcp(connectMatch[1] ?? '', workspaceFromBody(input)));
        return true;
      }

      const serverMatch = /^\/desktop\/integrations\/mcp\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(url.pathname);
      if (serverMatch) {
        const id = serverMatch[1] ?? '';
        if (request.method === 'PUT') {
          const input = await readJson(request);
          if (!input || typeof input !== 'object' || !('id' in input) || input.id !== id) {
            throw new HttpError(400, 'MCP server id must match the request path');
          }
          sendJson(response, 200, await control.configureMcp(input));
          return true;
        }
        if (request.method === 'DELETE') {
          sendJson(response, 200, await control.removeMcp(id));
          return true;
        }
        methodNotAllowed(response, ['PUT', 'DELETE']);
        return true;
      }

      return false;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : isMissing(error) ? 404 : 400;
      sendJson(response, status, {
        error: {
          type: status === 404 ? 'not_found' : 'invalid_request',
          message: error instanceof Error ? error.message : 'Integration request failed',
        },
      });
      return true;
    }
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function requireMethod(request: IncomingMessage, response: ServerResponse, expected: string): boolean {
  if (request.method === expected) return true;
  methodNotAllowed(response, [expected]);
  return false;
}

function methodNotAllowed(response: ServerResponse, allowed: string[]): void {
  response.setHeader('Allow', allowed.join(', '));
  sendJson(response, 405, { error: { type: 'invalid_request', message: 'Method not allowed' } });
}

async function readJson(request: IncomingMessage, required = true): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_CONFIG_BYTES) throw new HttpError(413, 'Integration configuration is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    if (required) throw new HttpError(400, 'JSON request body is required');
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

function workspaceFromQuery(url: URL): string | undefined {
  const values = url.searchParams.getAll('workspace');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || values[0]?.trim() === '') throw new HttpError(400, 'Workspace query must contain one path');
  return values[0];
}

function workspaceFromBody(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'MCP connect body must be a JSON object');
  }
  const fields = Object.keys(input);
  if (fields.some((field) => field !== 'workspace')) throw new HttpError(400, 'MCP connect body contains an unknown field');
  if (!('workspace' in input) || input.workspace === undefined) return undefined;
  if (typeof input.workspace !== 'string' || input.workspace.trim() === '') {
    throw new HttpError(400, 'MCP connect workspace must be a path');
  }
  return input.workspace;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
