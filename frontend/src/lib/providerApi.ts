/**
 * Client for the desktop's /desktop/providers surface.
 *
 * When the app runs inside Electron the main process owns provider records and
 * their API keys (encrypted by the OS keychain), and this module is how the
 * renderer edits them. The same bundle also ships inside the Go gateway, which
 * has no such surface — `providersSupported` is how the UI finds out which one
 * it is talking to.
 */

import { ApiError } from './api.ts';
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) throw new ApiError(errorMessage(text, response.status), response.status);
  return JSON.parse(text) as T;
}

function errorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON — fall through
  }
  return body.slice(0, 300) || `Request failed with status ${status}`;
}

/**
 * True when the backend owns providers. A 404 or 503 means the Go gateway (or
 * an older desktop build), where provider records stay in this browser profile.
 * A network failure is reported as unsupported too: refusing to render the
 * Settings list would be worse than rendering the local one.
 */
export async function providersSupported(): Promise<boolean> {
  try {
    const response = await fetch(BASE, { headers: { Accept: 'application/json' } });
    return response.ok;
  } catch {
    return false;
  }
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
