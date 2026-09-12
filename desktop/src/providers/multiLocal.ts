/**
 * MultiLocal — weighted round-robin across several OpenAI-compatible backends
 * with health-check-based failover. Ported from providers/multiLocal.go.
 *
 * The Go original guarded endpoint state with a mutex; JavaScript's single
 * threaded event loop makes that unnecessary, so the locking is simply gone.
 */

import { Effect } from 'effect';
import { ApiError, ErrorType, asApiError, runPromiseBoundary } from './errors.js';
import { LocalProvider } from './local.js';
import type { Provider } from './provider.js';
import type { ChatCompletionRequest, ChatCompletionResponse, Model, StreamChunk } from './types.js';

const MAX_BACKOFF_MULTIPLIER = 10; // cap backoff at 10x the base interval
const STAGGER_DELAY_MS = 5_000; // delay between endpoint checks after VM wake

export interface EndpointOption {
  name: string;
  baseUrl: string;
  /** nil for default */
  fetchImpl?: typeof fetch;
  /** round-robin weight (default: 1) */
  weight?: number;
}

/** A single backend instance plus its health state. */
class Endpoint {
  readonly local: LocalProvider;
  healthy = true;
  consecutiveFails = 0;
  /** epoch ms before which this endpoint is not re-probed; 0 means "due now". */
  nextCheck = 0;

  constructor(
    readonly name: string,
    readonly baseUrl: string,
    readonly fetchImpl: typeof fetch,
  ) {
    this.local = new LocalProvider({ baseUrl, fetchImpl });
  }
}

export interface MultiLocalOptions {
  /** Injected by tests so backoff and VM-sleep detection need no real waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Distinguishes "this endpoint is down" from "this request failed".
 *
 * A cancellation or an exhausted deadline is a property of the request, not the
 * endpoint, so it must not fail over — retrying an already-doomed request just
 * re-expires and marks every endpoint unhealthy. Everything else that fetch
 * reports as a transport failure (connection refused, DNS, a socket dropped
 * mid-response) is an endpoint failure worth failing over.
 */
export function isNetworkError(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof ApiError) return false; // an application-level error

  const name = (err as { name?: string }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return false;

  if (err instanceof TypeError) return true; // how fetch reports transport failures

  const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  if (typeof code === 'string') {
    return code !== 'ABORT_ERR';
  }
  return false;
}

export class MultiLocalProvider implements Provider {
  /** weighted: an endpoint with weight N appears N times */
  private readonly endpoints: Endpoint[] = [];
  /** deduplicated: one entry per physical endpoint */
  private readonly uniqueEndpoints: Endpoint[] = [];
  private counter = 0;
  private interval = 0;
  private timeout = 0;
  /** when checkAll last ran, used to detect VM sleep; 0 until the first run */
  private lastCheckAt = 0;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EndpointOption[], hooks: MultiLocalOptions = {}) {
    this.now = hooks.now ?? Date.now;
    this.sleep =
      hooks.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref();
        }));

    for (const option of options) {
      const endpoint = new Endpoint(option.name, option.baseUrl, option.fetchImpl ?? fetch);
      this.uniqueEndpoints.push(endpoint);

      const weight = option.weight && option.weight > 0 ? option.weight : 1;
      for (let i = 0; i < weight; i += 1) this.endpoints.push(endpoint);
    }
  }

  /** Next healthy endpoint; falls back to the first when all are unhealthy. */
  private next(): Endpoint {
    const n = this.endpoints.length;
    const start = this.counter;
    this.counter += 1;

    for (let i = 0; i < n; i += 1) {
      const endpoint = this.endpoints[(start + i) % n];
      if (endpoint?.healthy) return endpoint;
    }
    // all unhealthy — best-effort with the first endpoint
    const fallback = this.uniqueEndpoints[0];
    if (!fallback) throw new ApiError('no endpoints configured', ErrorType.InvalidRequest);
    return fallback;
  }

  async chatCompletion(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    let lastErr: unknown;

    for (let i = 0; i < this.uniqueEndpoints.length; i += 1) {
      const endpoint = this.next();
      try {
        return await endpoint.local.chatCompletion(req, signal);
      } catch (err) {
        if (!isNetworkError(err)) throw err; // application-level error — don't fail over
        endpoint.healthy = false;
        lastErr = err;
      }
    }
    throw new ApiError(`all endpoints failed, last error: ${describe(lastErr)}`, ErrorType.ServiceUnavailable);
  }

  /**
   * Failover applies to establishing the stream. Once chunks flow, an error is
   * the caller's to see — matching Go, where failover happened before the
   * reader goroutine started. The one behavioural difference: because the
   * connect and the first chunk arrive together through a generator, a socket
   * dropped before the very first chunk fails over here where Go surfaced it.
   */
  async *chatCompletionStream(
    req: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    let lastErr: unknown;

    for (let i = 0; i < this.uniqueEndpoints.length; i += 1) {
      const endpoint = this.next();
      const stream = endpoint.local.chatCompletionStream(req, signal)[Symbol.asyncIterator]();

      let first: IteratorResult<StreamChunk>;
      try {
        first = await stream.next();
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        endpoint.healthy = false;
        lastErr = err;
        continue;
      }

      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await stream.next();
        if (next.done) return;
        yield next.value;
      }
    }
    throw new ApiError(`all endpoints failed, last error: ${describe(lastErr)}`, ErrorType.ServiceUnavailable);
  }

  /** Union of models from all healthy endpoints, deduplicated by model ID. */
  async listModels(signal?: AbortSignal): Promise<Model[]> {
    const seen = new Set<string>();
    const models: Model[] = [];
    let lastErr: unknown;

    for (const endpoint of this.uniqueEndpoints) {
      if (!endpoint.healthy) continue;
      try {
        for (const model of await endpoint.local.listModels(signal)) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          models.push(model);
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (models.length === 0 && lastErr !== undefined) throw asApiError(lastErr);
    return models;
  }

  /**
   * Begins periodic health checking. Failing endpoints are rechecked with
   * exponential backoff (up to 10x the base interval) so infrastructure that is
   * rate-limiting does not get hammered.
   */
  startHealthChecks(intervalMs: number, timeoutMs: number): void {
    this.interval = intervalMs;
    this.timeout = timeoutMs;

    void this.checkAll(); // run an initial check immediately

    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    // a background probe loop must never be the reason the process stays alive
    this.timer.unref();
  }

  async checkAll(): Promise<void> {
    const now = this.now();

    // detect VM sleep: a gap longer than 2x the interval means the system
    // likely slept and every tunnelled session is stale. stagger the checks so
    // the controller is not flooded with simultaneous re-auth requests.
    const stagger = this.lastCheckAt !== 0 && now - this.lastCheckAt > this.interval * 2;
    this.lastCheckAt = now;

    for (const [index, endpoint] of this.uniqueEndpoints.entries()) {
      if (stagger && index > 0) await this.sleep(STAGGER_DELAY_MS);
      if (now < endpoint.nextCheck) continue;

      const healthy = await this.checkEndpoint(endpoint);
      endpoint.healthy = healthy;

      if (healthy) {
        endpoint.consecutiveFails = 0;
        endpoint.nextCheck = 0;
      } else {
        endpoint.consecutiveFails += 1;
        const backoff = Math.min(endpoint.consecutiveFails, MAX_BACKOFF_MULTIPLIER);
        endpoint.nextCheck = now + backoff * this.interval;
      }
    }
  }

  /** OpenAI-compatible probe first so non-Ollama backends pass; /api/tags after. */
  private async checkEndpoint(endpoint: Endpoint): Promise<boolean> {
    if (await this.probe(endpoint, '/v1/models')) return true;
    return this.probe(endpoint, '/api/tags');
  }

  private async probe(endpoint: Endpoint, path: string): Promise<boolean> {
    // Health probe as an interruptible Effect: Effect.timeout bounds it (the
    // old setTimeout+abort controller), and the Effect runtime's AbortSignal
    // aborts the fetch on interrupt.
    const program = Effect.tryPromise({
      try: (abortSignal) => endpoint.fetchImpl(endpoint.baseUrl + path, { signal: abortSignal }),
      catch: () => new ApiError('probe failed', ErrorType.Server),
    }).pipe(
      Effect.timeout(this.timeout > 0 ? this.timeout : '30 seconds'),
      Effect.catchAll(() => Effect.succeed(undefined as Response | undefined)),
    );
    const res = await runPromiseBoundary(program);
    if (!res) return false;
    try {
      // the body must be drained or the socket is held open
      await res.arrayBuffer().catch(() => undefined);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** First endpoint's base URL, for the embedding provider. */
  primaryBaseUrl(): string {
    const first = this.uniqueEndpoints[0];
    if (!first) throw new ApiError('no endpoints configured', ErrorType.InvalidRequest);
    return first.baseUrl;
  }

  /**
   * A fetch-compatible function that spreads requests across healthy endpoints
   * with failover, for the non-streaming embedding and classifier clients.
   * Replaces Go's RoundRobinClient/roundRobinTransport.
   */
  roundRobinFetch(): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = pathOf(input);
      const n = this.endpoints.length;
      const start = this.counter;
      this.counter += 1;

      // a stream body cannot be replayed against a second endpoint
      const replayable = !(init?.body instanceof ReadableStream);

      let lastErr: unknown;
      let tried = 0;

      for (let i = 0; i < n; i += 1) {
        const endpoint = this.endpoints[(start + i) % n];
        if (!endpoint?.healthy) continue;
        tried += 1;

        try {
          return await bufferResponse(await endpoint.fetchImpl(endpoint.baseUrl + path, init));
        } catch (err) {
          if (!isNetworkError(err)) throw err;
          endpoint.healthy = false;
          if (!replayable) throw err;
          lastErr = err;
        }
      }

      // all unhealthy — best-effort with the first endpoint
      if (tried === 0) {
        const first = this.endpoints[0];
        if (!first) throw new ApiError('no endpoints configured', ErrorType.InvalidRequest);
        return bufferResponse(await first.fetchImpl(first.baseUrl + path, init));
      }
      throw new ApiError(`all endpoints failed, last error: ${describe(lastErr)}`, ErrorType.ServiceUnavailable);
    };
  }

  /** Stops health checks and releases resources. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Reads the body here so a connection that dies after the headers arrived is
 * caught by the retry loop rather than surfacing to the caller once the request
 * has apparently succeeded. This path serves only the non-streaming embedding
 * and classifier clients, which read the whole body anyway, so buffering costs
 * nothing extra.
 */
async function bufferResponse(res: Response): Promise<Response> {
  // 204 and 304 must not carry a body, and constructing one with it throws
  if (res.status === 204 || res.status === 304) return res;
  const body = await res.arrayBuffer();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Keeps only the path+query, so the endpoint's own origin is substituted. */
function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw);
    return url.pathname + url.search;
  } catch {
    return raw.startsWith('/') ? raw : `/${raw}`;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
