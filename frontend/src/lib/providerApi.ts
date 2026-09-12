/**
 * Client for the desktop's /desktop/providers surface.
 *
 * When the app runs inside Electron the main process owns provider records and
 * their API keys (encrypted by the OS keychain), and this module is how the
 * renderer edits them. The same bundle also ships inside the Go gateway, which
 * has no such surface — `providersSupported` is how the UI finds out which one
 * it is talking to.
 *
 * Effect-based inside (Effect.tryPromise + TaggedError via api.ts), Promise
 * at the boundary so callers keep `await`ing plain promises.
 */

import { Effect } from 'effect';
import { ApiHttpError, ApiNetworkError, classifyErrorBody, runPromiseBoundary } from './api.ts';
import type { ProviderConnectionStatus, ProviderKind } from '../types.ts';

/** A provider as the desktop reports it. Never carries the API key. */
export interface RemoteProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  model: string;
  discoveredModels: string[];
  visionModels: string[];
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
  source: 'user' | 'config';
  readOnly: boolean;
}

export interface RemoteProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  model?: string;
}

/** Absent `apiKey` keeps the stored key; '' clears it; a string replaces it. */
export interface RemoteProviderPatch {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  model?: string;
}

const BASE = '/desktop/providers';

function requestEffect<T>(path: string, init?: RequestInit): Effect.Effect<T, ApiHttpError | ApiNetworkError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (abortSignal) =>
        fetch(path, {
          ...init,
          headers: {
            Accept: 'application/json',
            ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
            ...init?.headers,
          },
          signal: init?.signal ? AbortSignal.any([init.signal, abortSignal]) : abortSignal,
        }),
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return Effect.fail(err as never);
        if (err instanceof TypeError) return Effect.fail(err as never);
        const message = err instanceof Error ? err.message : String(err);
        return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
      }),
    );
    if (response.status === 204) return undefined as T;
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return Effect.fail(err as never);
        if (err instanceof TypeError) return Effect.fail(err as never);
        const message = err instanceof Error ? err.message : String(err);
        return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
      }),
    );
    if (!response.ok) {
      const { message, shape } = classifyErrorBody(text, response.status);
      return yield* Effect.fail(new ApiHttpError({ message, status: response.status, shape }));
    }
    return (yield* Effect.try({
      try: () => JSON.parse(text) as T,
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        const message = err instanceof Error ? err.message : String(err);
        return Effect.fail(new ApiNetworkError({ message, reason: 'transport', cause: err }));
      }),
    )) as T;
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return runPromiseBoundary(requestEffect<T>(path, init));
}

/**
 * True when the backend owns providers. A 404 or 503 means the Go gateway (or
 * an older desktop build), where provider records stay in this browser profile.
 * A network failure is reported as unsupported too: refusing to render the
 * Settings list would be worse than rendering the local one.
 */
export async function providersSupported(): Promise<boolean> {
  return runPromiseBoundary(providersSupportedEffect());
}

function providersSupportedEffect(): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: (abortSignal) => fetch(BASE, { headers: { Accept: 'application/json' }, signal: abortSignal }),
    catch: () => false as const,
  }).pipe(
    Effect.flatMap((response) => {
      if (typeof response === 'boolean') return Effect.succeed(false);
      return Effect.succeed((response as Response).ok);
    }),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

export async function listProviders(): Promise<RemoteProvider[]> {
  return (await request<{ providers: RemoteProvider[] }>(BASE)).providers;
}

export async function createProvider(input: RemoteProviderInput): Promise<RemoteProvider> {
  const { provider } = await request<{ provider: RemoteProvider }>(BASE, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return provider;
}

export async function patchProvider(
  id: string,
  patch: RemoteProviderPatch,
): Promise<RemoteProvider> {
  const { provider } = await request<{ provider: RemoteProvider }>(
    `${BASE}/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return provider;
}

export async function deleteProvider(id: string): Promise<void> {
  await request<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Probes the upstream and returns the provider with the outcome recorded. */
export async function testProvider(id: string): Promise<RemoteProvider> {
  const { provider } = await request<{ provider: RemoteProvider }>(
    `${BASE}/${encodeURIComponent(id)}/test`,
    { method: 'POST' },
  );
  return provider;
}
