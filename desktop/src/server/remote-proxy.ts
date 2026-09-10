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
import { ApiError, ErrorType, writeError } from '../providers/errors.js';
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
  // streaming into a closed socket.
  const aborter = new AbortController();
  res.on('close', () => aborter.abort());
  const signal = AbortSignal.any([aborter.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await fetchFollowing(target, {
      method: req.method ?? 'GET',
      headers,
      body,
      signal,
      redirect: 'manual',
    });
  } catch (err) {
    if (res.writableEnded || aborter.signal.aborted) return;
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
