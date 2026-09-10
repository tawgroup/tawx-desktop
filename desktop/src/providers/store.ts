/**
 * On-disk persistence for user-configured providers.
 *
 * Same shape as scheduler/store.ts: a single versioned JSON document, written
 * to a temp file and renamed so a crash cannot leave a half-written state. The
 * API key inside each record is ciphertext (see secrets.ts) — the file mode is
 * 0600 as a second line of defence, not the first.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderKindValue } from './kinds.js';

export type ProviderConnectionStatus = 'untested' | 'connected' | 'error';

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKindValue;
  baseUrl: string;
  /** base64 safeStorage ciphertext, or '' for a provider that needs no key. */
  secret: string;
  enabled: boolean;
  model: string;
  discoveredModels: string[];
  visionModels?: string[];
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedProviders {
  version: 1;
  providers: ProviderRecord[];
}

const EMPTY_STATE: PersistedProviders = { version: 1, providers: [] };

export class ProviderStore {
  readonly filePath: string;

  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'providers.json');
  }

  async load(): Promise<PersistedProviders> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let source: string;
    try {
      source = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(EMPTY_STATE);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(
        `Cannot read provider state at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isPersistedState(parsed)) {
      throw new Error(`Cannot read provider state at ${this.filePath}: unsupported or malformed data`);
    }
    return structuredClone(parsed);
  }

  async save(state: PersistedProviders): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isPersistedState(value: unknown): value is PersistedProviders {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedProviders>;
  return candidate.version === 1 && Array.isArray(candidate.providers);
}
