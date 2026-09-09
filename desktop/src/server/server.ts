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
import { TaskRuntime, TaskRuntimeError } from '../agent/runtime.js';
import type { AgentEvent, AgentTaskRequest, ApprovalDecision, DesktopHttpHandler, WorkspaceSnapshot } from '../agent/types.js';
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
const MAX_DESKTOP_BODY_BYTES = 64 * 1024 * 1024;

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
  desktop?: {
    runtime: TaskRuntime;
    selectWorkspace(): Promise<WorkspaceSnapshot | undefined>;
    handlers?: DesktopHttpHandler[];
  };
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options).catch((err) => {
      if ((req.url ?? '').startsWith('/desktop/')) {
        if (!res.headersSent) {
          const status = err instanceof TaskRuntimeError ? err.status : 500;
          sendJson(res, status, { error: { message: errorMessage(err) } });
        } else {
          res.end();
        }
        return;
      }
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
  if (path.startsWith('/desktop/')) {
    if (!isSameOriginDesktopRequest(req)) {
      return sendJson(res, 403, { error: { message: 'cross-origin desktop control request denied' } });
    }
    if (!options.desktop) {
      return sendJson(res, 503, { error: { message: 'desktop control surface is unavailable' } });
    }
    if (await handleDesktop(req, res, url, method, options.desktop)) return;
    return sendJson(res, 404, { error: { message: `unknown path '${path}'` } });
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

function isSameOriginDesktopRequest(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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

async function handleDesktop(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  desktop: NonNullable<GatewayServerOptions['desktop']>,
): Promise<boolean> {
  const path = url.pathname;
  if (path === '/desktop/workspace/select') {
    if (method !== 'POST') {
      methodNotAllowed(method, path, res);
      return true;
    }
    const workspace = await desktop.selectWorkspace();
    if (!workspace) {
      res.writeHead(204);
      res.end();
    } else {
      sendJson(res, 200, workspace);
    }
    return true;
  }

  if (path === '/desktop/capabilities') {
    if (method !== 'GET') {
      methodNotAllowed(method, path, res);
      return true;
    }
    sendJson(res, 200, { tools: desktop.runtime.capabilities() });
    return true;
  }

  if (path === '/desktop/tasks') {
    if (method !== 'POST') {
      methodNotAllowed(method, path, res);
      return true;
    }
    const body = await readJsonBody(req);
    sendJson(res, 202, await desktop.runtime.dispatch(body as AgentTaskRequest));
    return true;
  }

  const taskMatch = path.match(/^\/desktop\/tasks\/([^/]+)$/);
  if (taskMatch) {
    if (method !== 'GET') {
      methodNotAllowed(method, path, res);
      return true;
    }
    const task = desktop.runtime.get(decodeURIComponent(taskMatch[1]!));
    if (!task) throw new TaskRuntimeError('task not found', 404);
    sendJson(res, 200, task);
    return true;
  }

  const eventsMatch = path.match(/^\/desktop\/tasks\/([^/]+)\/events$/);
  if (eventsMatch) {
    if (method !== 'GET') {
      methodNotAllowed(method, path, res);
      return true;
    }
    streamTaskEvents(req, res, desktop.runtime, decodeURIComponent(eventsMatch[1]!), url);
    return true;
  }

  const approvalMatch = path.match(/^\/desktop\/tasks\/([^/]+)\/approvals\/([^/]+)$/);
  if (approvalMatch) {
    if (method !== 'POST') {
      methodNotAllowed(method, path, res);
      return true;
    }
    const body = await readJsonBody(req) as { decision?: unknown };
    const task = await desktop.runtime.approve(
      decodeURIComponent(approvalMatch[1]!),
      decodeURIComponent(approvalMatch[2]!),
      body.decision as ApprovalDecision,
    );
    sendJson(res, 200, task);
    return true;
  }

  const actionMatch = path.match(/^\/desktop\/tasks\/([^/]+)\/(cancel|undo)$/);
  if (actionMatch) {
    if (method !== 'POST') {
      methodNotAllowed(method, path, res);
      return true;
    }
    const taskId = decodeURIComponent(actionMatch[1]!);
    if (actionMatch[2] === 'cancel') {
      sendJson(res, 200, await desktop.runtime.cancel(taskId));
    } else {
      const body = await readOptionalJsonBody(req) as { checkpointId?: string };
      sendJson(res, 200, await desktop.runtime.undo(taskId, body.checkpointId));
    }
    return true;
  }

  for (const handler of desktop.handlers ?? []) {
    if (await handler({ request: req, response: res, url })) return true;
  }
  return false;
}

function streamTaskEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: TaskRuntime,
  taskId: string,
  url: URL,
): void {
  const headerId = Number(req.headers['last-event-id'] ?? 0);
  const queryId = Number(url.searchParams.get('after') ?? 0);
  const after = Number.isFinite(headerId) && headerId > 0
    ? headerId
    : (Number.isFinite(queryId) && queryId > 0 ? queryId : 0);
  let closed = false;
  let unsubscribe = (): void => {};
  let heartbeat: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  const write = (event: AgentEvent): void => {
    if (closed) return;
    res.write(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.kind === 'done' || event.kind === 'error') close();
  };
  if (!runtime.get(taskId)) throw new TaskRuntimeError('task not found', 404);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const subscription = runtime.subscribe(taskId, after, write);
  if (!subscription) {
    close();
    return;
  }
  unsubscribe = subscription.unsubscribe;
  res.on('close', close);
  for (const event of subscription.events) write(event);
  if (closed) return;
  if (subscription.state === 'completed' || subscription.state === 'failed' || subscription.state === 'cancelled') {
    close();
    return;
  }
  heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();
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
  let size = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    size += chunk.length;
    if (size > MAX_DESKTOP_BODY_BYTES) throw new TaskRuntimeError('request body is too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(req);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TaskRuntimeError('request body must be valid JSON', 400);
  }
}

async function readOptionalJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TaskRuntimeError('request body must be valid JSON', 400);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}
