/**
 * The gateway HTTP surface, running inside the Electron main process.
 * Ported from gateway/handler.go.
 *
 * Keeping this an HTTP server rather than collapsing it into Electron IPC is
 * deliberate: it preserves the OpenAI-compatible endpoint, so any client can
 * still point at 127.0.0.1:18080/v1 exactly as it did against the Go binary.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ApiError, ErrorType, asApiError, errInvalidJson, errMessagesRequired, errModelRequired, statusCodeForError, writeError } from '../providers/errors.js';
import { SseWriter } from './sse.js';
import type { Router } from '../providers/router.js';
import type { ChatCompletionRequest, Model } from '../providers/types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

export interface GatewayServerOptions {
  router: Router;
  /** Directory holding the built frontend (index.html + assets/). */
  webRoot: string;
  /**
   * Resolves a model-less or `auto` request to a concrete model. Supplied by
   * the routing package; without it, such a request is rejected rather than
   * silently guessed at.
   */
  resolveModel?: (req: ChatCompletionRequest) => Promise<string>;
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options).catch((err) => {
      const apiErr = asApiError(err);
      if (!res.headersSent) writeError(res, apiErr, statusCodeForError(apiErr.type));
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/health') return expectGet(method, path, res, () => sendJson(res, 200, { status: 'ok' }));

  if (path === '/v1') {
    return expectGet(method, path, res, () =>
      sendJson(res, 200, {
        status: 'ok',
        endpoints: { models: 'GET /v1/models', chat_completions: 'POST /v1/chat/completions' },
      }),
    );
  }

  if (path === '/v1/models') {
    return expectGet(method, path, res, () => handleModels(res, options));
  }

  if (path === '/v1/chat/completions') {
    if (method !== 'POST') return methodNotAllowed(method, path, res);
    return handleChatCompletions(req, res, options);
  }

  if (method === 'GET' && (path === '/' || path === '/favicon.svg' || path.startsWith('/assets/'))) {
    return serveStatic(path, res, options.webRoot);
  }

  writeError(res, new ApiError(`unknown path '${path}'`, ErrorType.NotFound), 404);
}

function expectGet(
  method: string,
  path: string,
  res: ServerResponse,
  handler: () => void | Promise<void>,
): void | Promise<void> {
  if (method !== 'GET') return methodNotAllowed(method, path, res);
  return handler();
}

function methodNotAllowed(method: string, path: string, res: ServerResponse): void {
  writeError(res, new ApiError(`method ${method} is not allowed for '${path}'`, ErrorType.InvalidRequest), 405);
}

async function handleModels(res: ServerResponse, options: GatewayServerOptions): Promise<void> {
  const seen = new Set<string>();
  const models: Model[] = [];
  let lastErr: unknown;

  for (const providerType of ['openai', 'openrouter', 'anthropic', 'local'] as const) {
    const provider = options.router.getProvider(providerType);
    if (!provider) continue;
    try {
      for (const model of await provider.listModels()) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
    } catch (err) {
      // one unreachable backend must not empty the whole model list
      lastErr = err;
    }
  }

  if (models.length === 0 && lastErr !== undefined) throw asApiError(lastErr);
  sendJson(res, 200, { object: 'list', data: models });
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayServerOptions,
): Promise<void> {
  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(await readRequestBody(req)) as ChatCompletionRequest;
  } catch {
    return writeError(res, errInvalidJson(), 400);
  }

  if (!Array.isArray(body.messages)) return writeError(res, errMessagesRequired(), 400);

  if (!body.model || body.model === 'auto') {
    if (!options.resolveModel) return writeError(res, errModelRequired(), 400);
    body.model = await options.resolveModel(body);
  }

  const { provider } = options.router.route(body.model);

  // the client aborting must cancel the upstream request, not leak it
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  if (!body.stream) {
    const completion = await provider.chatCompletion(body, controller.signal);
    return sendJson(res, 200, completion);
  }

  const sse = new SseWriter(res);
  sse.writeHeaders();
  try {
    for await (const chunk of provider.chatCompletionStream(body, controller.signal)) {
      sse.writeChunk(chunk);
    }
    sse.writeDone();
  } catch (err) {
    // headers are already out, so the failure can only be reported in-band
    sse.writeError(asApiError(err));
  } finally {
    res.end();
  }
}

async function serveStatic(path: string, res: ServerResponse, webRoot: string): Promise<void> {
  const relativePath = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '');
  const file = join(webRoot, relativePath);

  // normalize plus this check keeps a crafted /assets/../../ path inside webRoot
  if (!file.startsWith(webRoot)) {
    return writeError(res, new ApiError('not found', ErrorType.NotFound), 404);
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');

    const headers: Record<string, string> = {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
    };
    // index.html must never be cached, or a rebuilt UI keeps serving stale assets
    if (relativePath === 'index.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';

    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch {
    writeError(res, new ApiError(`unknown path '${path}'`, ErrorType.NotFound), 404);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
