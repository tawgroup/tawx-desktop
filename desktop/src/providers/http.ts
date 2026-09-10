/**
 * The /desktop/providers control surface. Same DesktopHttpHandler shape as
 * scheduler/http.ts, and behind the same same-origin guard in server.ts.
 *
 * PATCH semantics for `apiKey`: absent keeps the stored key, '' clears it, a
 * string replaces it. There is no way to read a key back out.
 */

import { ApiError, ErrorType, asApiError, statusCodeForError, writeError } from './errors.js';
import type { ProviderInput, ProviderPatch, ProviderRuntime } from './registry.js';
import type { DesktopHttpHandler } from '../agent/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 64 * 1024;

export function createProvidersHttpHandler(runtime: ProviderRuntime): DesktopHttpHandler {
  return async ({ request, response, url }) => {
    const path = url.pathname;
    if (path !== '/desktop/providers' && !path.startsWith('/desktop/providers/')) return false;
    try {
      await route(runtime, request, response, path);
    } catch (error) {
      const apiError = asApiError(error);
      writeError(response, apiError, statusCodeForError(apiError.type));
    }
    return true;
  };
}

async function route(
  runtime: ProviderRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (path === '/desktop/providers') {
    if (method === 'GET') return sendJson(res, 200, { providers: runtime.list() });
    if (method === 'POST') {
      const input = (await readJson(req)) as ProviderInput;
      return sendJson(res, 201, { provider: await runtime.create(input) });
    }
    return methodNotAllowed(res, method, path);
  }

  const testMatch = /^\/desktop\/providers\/([^/]+)\/test$/.exec(path);
  if (testMatch) {
    if (method !== 'POST') return methodNotAllowed(res, method, path);
    const id = decodeId(testMatch[1]);
    // The probe reaches an upstream; a client that gives up must not leave it
    // running.
    const aborter = new AbortController();
    res.on('close', () => aborter.abort());
    return sendJson(res, 200, { provider: await runtime.test(id, aborter.signal) });
  }

  const idMatch = /^\/desktop\/providers\/([^/]+)$/.exec(path);
  if (idMatch) {
    const id = decodeId(idMatch[1]);
    if (method === 'GET') return sendJson(res, 200, { provider: runtime.get(id) });
    if (method === 'PATCH') {
      const patch = (await readJson(req)) as ProviderPatch;
      return sendJson(res, 200, { provider: await runtime.update(id, patch) });
    }
    if (method === 'DELETE') {
      await runtime.remove(id);
      res.writeHead(204);
      res.end();
      return;
    }
    return methodNotAllowed(res, method, path);
  }

  throw new ApiError(`unknown path '${path}'`, ErrorType.NotFound);
}

function decodeId(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    throw new ApiError('provider id is malformed', ErrorType.InvalidRequest);
  }
}

function methodNotAllowed(res: ServerResponse, method: string, path: string): void {
  writeError(
    res,
    new ApiError(`method ${method} is not allowed for '${path}'`, ErrorType.InvalidRequest),
    405,
  );
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Returns `unknown`: the runtime validates every field it uses, so a shape
 * assertion here would only move the lie earlier.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError('request body is too large', ErrorType.InvalidRequest);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError('request body must be valid JSON', ErrorType.InvalidRequest);
  }
}
