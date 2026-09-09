import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DesktopHttpHandler } from '../agent/types.js';
import { InvalidScheduleTriggerError } from './next-run.js';
import { ScheduleNotFoundError, SchedulerRuntime, SchedulerValidationError } from './runtime.js';
import type { CreateScheduleInput, UpdateScheduleInput } from './types.js';

const MAX_BODY_BYTES = 1_048_576;

/**
 * A compact server extension: return false for non-scheduler URLs so the
 * gateway can continue routing, and fully own every /desktop/schedules URL.
 */
export function createSchedulerHttpHandler(runtime: SchedulerRuntime): DesktopHttpHandler {
  return async ({ request, response, url }) => {
    if (url.pathname !== '/desktop/schedules' && !url.pathname.startsWith('/desktop/schedules/')) return false;
    try {
      await routeSchedulerRequest(runtime, request, response, url.pathname);
    } catch (error) {
      writeSchedulerError(response, error);
    }
    return true;
  };
}

async function routeSchedulerRequest(
  runtime: SchedulerRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (path === '/desktop/schedules') {
    if (method === 'GET') {
      sendJson(res, 200, { schedules: await runtime.list() });
      return;
    }
    if (method === 'POST') {
      const input = await readJson<CreateScheduleInput>(req);
      sendJson(res, 201, { schedule: await runtime.create(input) });
      return;
    }
    methodNotAllowed(res, ['GET', 'POST']);
    return;
  }

  const match = /^\/desktop\/schedules\/([^/]+)(?:\/(history|enable))?$/.exec(path);
  if (!match) throw new ScheduleNotFoundError(path.slice('/desktop/schedules/'.length));
  let id: string;
  try {
    id = decodeURIComponent(match[1] ?? '');
  } catch {
    throw new SchedulerValidationError('schedule id is malformed');
  }
  const action = match[2];

  if (action === 'history') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    sendJson(res, 200, { history: await runtime.history(id) });
    return;
  }
  if (action === 'enable') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJson<{ enabled?: unknown }>(req);
    if (typeof body.enabled !== 'boolean') throw new SchedulerValidationError('enabled must be a boolean');
    sendJson(res, 200, { schedule: await runtime.setEnabled(id, body.enabled) });
    return;
  }

  if (method === 'GET') {
    sendJson(res, 200, { schedule: await runtime.get(id) });
    return;
  }
  if (method === 'PUT') {
    const input = await readJson<UpdateScheduleInput>(req);
    sendJson(res, 200, { schedule: await runtime.update(id, input) });
    return;
  }
  if (method === 'DELETE') {
    await runtime.remove(id);
    res.writeHead(204);
    res.end();
    return;
  }
  methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new SchedulerHttpError(415, 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new SchedulerHttpError(413, 'Request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new SchedulerValidationError('request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new SchedulerValidationError('request body must be valid JSON');
  }
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: { message: 'Method not allowed' } });
}

function writeSchedulerError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ScheduleNotFoundError) {
    sendJson(res, 404, { error: { message: error.message } });
    return;
  }
  if (error instanceof SchedulerValidationError || error instanceof InvalidScheduleTriggerError) {
    sendJson(res, 400, { error: { message: error.message } });
    return;
  }
  if (error instanceof SchedulerHttpError) {
    sendJson(res, error.status, { error: { message: error.message } });
    return;
  }
  sendJson(res, 500, { error: { message: 'Scheduler request failed' } });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

class SchedulerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SchedulerHttpError';
  }
}
