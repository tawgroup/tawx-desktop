/**
 * Same-origin proxy for user-configured remote providers.
 * Ported from gateway/remote_proxy.go.
 *
 * The frontend rewrites any absolute provider baseUrl to
 * `/proxy/remote?url=<encoded>` (see frontend/src/lib/api.ts) so the browser
 * never fires a CORS preflight against a provider that may not allow one.
 * Without this route the Electron build answers `unknown path '/proxy/remote'`
 * and no remote provider can be tested or used.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Effect, Schedule } from 'effect';
import { ApiError, ErrorType, runPromiseBoundary, writeError } from '../providers/errors.js';
import { assertProviderUrl, isLoopbackHost } from '../providers/url.js';

const MAX_REQUEST_BYTES = 4 << 20;
const MAX_RESPONSE_BYTES = 8 << 20;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/** The proxy is a local convenience, never a general-purpose open relay. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address !== undefined && isLoopbackHost(address);
}

/**
 * Reads the request body with the same 4MB cap as the Go proxy. Kept separate
 * from server.ts's readRequestBody, which caps at 64MB and throws the
 * `/desktop/`-only error type.
 */
async function readCappedBody(req: IncomingMessage): Promise<ArrayBuffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new ApiError('provider request body is too large', ErrorType.InvalidRequest);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  // An ArrayBuffer rather than the Buffer itself: fetch's BodyInit does not
  // accept Node's Buffer type under this lib configuration.
  const merged = Buffer.concat(chunks);
  const body = new ArrayBuffer(merged.byteLength);
  new Uint8Array(body).set(merged);
  return body;
}

/**
 * Follows redirects by hand so each hop is re-validated against
 * assertProviderUrl, the way Go's CheckRedirect does. undici's `follow` mode gives
 * no hook to inspect the intermediate URL.
 */
async function fetchFollowing(
  target: URL,
  init: RequestInit & { redirect: 'manual' },
): Promise<Response> {
  let url = target;
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new ApiError('too many provider redirects', ErrorType.InvalidRequest);
    }
    // Drain the redirect body so the socket returns to the pool.
    await response.body?.cancel();
    url = assertProviderUrl(new URL(location, url).toString());
  }
}

export async function handleRemoteProvider(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!isLoopbackRequest(req)) {
    return writeError(
      res,
      new ApiError(
        'provider connections are available only from the local desktop',
        ErrorType.Permission,
      ),
      403,
    );
  }

  let target: URL;
  let body: ArrayBuffer | undefined;
  try {
    target = assertProviderUrl(url.searchParams.get('url') ?? '');
    body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readCappedBody(req);
  } catch (err) {
    const apiErr =
      err instanceof ApiError ? err : new ApiError('invalid provider request', ErrorType.InvalidRequest);
    return writeError(res, apiErr, 400);
  }

  // Only the two headers the Go proxy forwards. Anything else — cookies, the
  // desktop's own origin — stays out of the upstream request.
  const headers = new Headers();
  const contentType = req.headers['content-type'];
  const authorization = req.headers.authorization;
  if (typeof contentType === 'string') headers.set('Content-Type', contentType);
  if (typeof authorization === 'string') headers.set('Authorization', authorization);

  // A client that navigates away or hits stop must not leave the upstream
  // streaming into a closed socket. The abort wiring lives in an Effect scope
  // (acquire registers res.on('close'), release removes it); the upstream
  // fetch itself runs as an interruptible Effect bounded by Effect.timeout and
  // replayed by Effect.retry on transport failures only, so ApiError rejections
  // (too many redirects) stay single-shot and keep their 400 mapping below.
  const upstreamRetry = Schedule.intersect(Schedule.exponential('200 millis'), Schedule.recurs(2));
  const isRetryableUpstream = (err: unknown): boolean => {
    if (err instanceof ApiError) return false;
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return false;
    if ((err as { _tag?: string })?._tag === 'TimeoutException') return true;
    return err instanceof TypeError;
  };

  let response: Response;
  try {
    response = await runPromiseBoundary(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const aborter = new AbortController();
          const onClose = () => aborter.abort();
          res.on('close', onClose);
          return { aborter, onClose };
        }),
        ({ aborter }) =>
          Effect.retry(
            Effect.tryPromise({
              try: (effectSignal) =>
                fetchFollowing(target, {
                  method: req.method ?? 'GET',
                  headers,
                  body,
                  signal: AbortSignal.any([
                    aborter.signal,
                    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    effectSignal,
                  ]),
                  redirect: 'manual',
                }),
              // Keep the error channel unknown: ApiError stays ApiError (400
              // below), transport failures stay raw (502 below).
              catch: (err) => err,
            }).pipe(
              Effect.timeout(`${REQUEST_TIMEOUT_MS} millis` as const),
              Effect.catchAll((err) => Effect.fail(err)),
            ),
            { schedule: upstreamRetry, while: isRetryableUpstream },
          ),
        ({ onClose }) => Effect.sync(() => res.removeListener('close', onClose)),
      ),
    );
  } catch (err) {
    // The Effect scope already released the abort wiring; if the response is
    // over or the socket is gone there is nothing left to answer.
    if (res.writableEnded || res.destroyed) return;
    const apiErr =
      err instanceof ApiError ? err : new ApiError('provider connection failed', ErrorType.Server);
    return writeError(res, apiErr, err instanceof ApiError ? 400 : 502);
  }

  // Streamed passthrough, not buffered: chat completions come back as SSE, and
  // buffering to enforce the cap would stall every token until the turn ended.
  res.writeHead(response.status, {
    'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
  });
  if (!response.body) return void res.end();

  let written = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        break;
      }
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } catch {
    // Upstream died or the client vanished mid-stream; headers are already out,
    // so closing the response is the only thing left to say.
  }
  res.end();
}
