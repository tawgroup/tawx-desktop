/**
 * Runtime ownership of user-configured providers.
 *
 * Providers added in Settings live here, in the main process, rather than in
 * the renderer's IndexedDB: the API key is then encrypted by the OS keychain
 * and never has to travel with a chat request. The frontend addresses them
 * through the normal `/v1` contract as `<providerId>/<model>`.
 *
 * Config-file providers are reported alongside them, read-only, so the Settings
 * list can show everything the gateway can reach from one source.
 */

import { randomUUID } from 'node:crypto';
import { ApiError, ErrorType } from './errors.js';
import { createProvider, PROVIDER_KINDS, type ProviderKindValue } from './kinds.js';
import { ProviderStore, type ProviderConnectionStatus, type ProviderRecord } from './store.js';
import { adapterBaseUrl, assertProviderUrl } from './url.js';
import type { Router } from './router.js';
import type { SecretCipher } from './secrets.js';

/**
 * What the frontend sees. The API key is never included — only whether one is
 * held, which is all `isProviderRoutable` needs to know.
 */
export interface ProviderView {
  id: string;
  name: string;
  kind: ProviderKindValue;
  baseUrl: string;
  hasApiKey: boolean;
  enabled: boolean;
  model: string;
  discoveredModels: string[];
  connectionStatus: ProviderConnectionStatus;
  lastError?: string;
  lastCheckedAt?: number;
  /** `config` entries come from config.yaml and cannot be edited here. */
  source: 'user' | 'config';
  readOnly: boolean;
}

export interface ProviderInput {
  id?: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  model?: string;
}

export interface ProviderPatch {
  name?: string;
  kind?: string;
  baseUrl?: string;
  /** Absent keeps the stored key; '' clears it; a string replaces it. */
  apiKey?: string;
  enabled?: boolean;
  model?: string;
}

export interface ProviderRuntimeOptions {
  directory: string;
  router: Router;
  cipher: SecretCipher;
  /** Ids already occupied by config.yaml providers, which must not be shadowed. */
  configIds?: string[];
}

/** Ids become a path segment in `<providerId>/<model>`, so a slash is fatal. */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export class ProviderRuntime {
  private readonly store: ProviderStore;
  private readonly router: Router;
  private readonly cipher: SecretCipher;
  private readonly configIds: Set<string>;
  private records = new Map<string, ProviderRecord>();

  private constructor(options: ProviderRuntimeOptions) {
    this.store = new ProviderStore(options.directory);
    this.router = options.router;
    this.cipher = options.cipher;
    this.configIds = new Set(options.configIds ?? []);
  }

  static async open(options: ProviderRuntimeOptions): Promise<ProviderRuntime> {
    const runtime = new ProviderRuntime(options);
    const state = await runtime.store.load();
    for (const record of state.providers) {
      runtime.records.set(record.id, record);
      runtime.mount(record);
    }
    return runtime;
  }

  /** Config providers first, then user providers in insertion order. */
  list(): ProviderView[] {
    const config: ProviderView[] = [...this.configIds].map((id) => ({
      id,
      name: id,
      // A config provider's kind is not recorded; it is not editable, and the
      // frontend only needs a label for it.
      kind: 'openai-compatible' as ProviderKindValue,
      baseUrl: '',
      hasApiKey: true,
      enabled: true,
      model: '',
      discoveredModels: [],
      connectionStatus: 'connected' as ProviderConnectionStatus,
      source: 'config' as const,
      readOnly: true,
    }));
    return [...config, ...[...this.records.values()].map((record) => this.toView(record))];
  }

  get(id: string): ProviderView {
    return this.toView(this.require(id));
  }

  async create(input: ProviderInput): Promise<ProviderView> {
    const kind = this.assertKind(input.kind);
    const baseUrl = assertProviderUrl(input.baseUrl).toString();
    // Absent means "generate one"; an empty string is a client bug and must not
    // be quietly turned into a UUID the caller did not ask for.
    const id = input.id === undefined ? randomUUID() : this.assertFreeId(input.id);
    const name = assertName(input.name);
    const now = Date.now();

    const record: ProviderRecord = {
      id,
      name,
      kind,
      baseUrl,
      secret: this.seal(input.apiKey ?? ''),
      enabled: input.enabled ?? true,
      model: input.model?.trim() ?? '',
      discoveredModels: [],
      connectionStatus: 'untested',
      createdAt: now,
      updatedAt: now,
    };

    // Disk first: a failed write must not leave a provider that answers
    // requests now and vanishes on the next launch.
    await this.commit([...this.records.values(), record]);
    this.records.set(id, record);
    this.mount(record);
    return this.toView(record);
  }

  async update(id: string, patch: ProviderPatch): Promise<ProviderView> {
    const current = this.require(id);
    const next: ProviderRecord = {
      ...current,
      ...(patch.name !== undefined && { name: assertName(patch.name) }),
      ...(patch.kind !== undefined && { kind: this.assertKind(patch.kind) }),
      ...(patch.baseUrl !== undefined && { baseUrl: assertProviderUrl(patch.baseUrl).toString() }),
      ...(patch.apiKey !== undefined && { secret: this.seal(patch.apiKey) }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.model !== undefined && { model: patch.model.trim() }),
      updatedAt: Date.now(),
    };
    // Anything that changes how the upstream is reached invalidates the probe.
    if (patch.kind !== undefined || patch.baseUrl !== undefined || patch.apiKey !== undefined) {
      next.connectionStatus = 'untested';
      delete next.lastError;
      delete next.lastCheckedAt;
    }

    await this.commit([...this.records.values()].map((record) => (record.id === id ? next : record)));
    this.records.set(id, next);
    this.mount(next);
    return this.toView(next);
  }

  async remove(id: string): Promise<void> {
    this.require(id);
    await this.commit([...this.records.values()].filter((record) => record.id !== id));
    this.records.delete(id);
    this.router.unregister(id);
  }

  /**
   * Probes the upstream by listing its models, and records the outcome. A
   * failure is stored, not thrown: "cannot connect" is a state of the provider,
   * and the Settings UI shows it per row.
   */
  async test(id: string, signal?: AbortSignal): Promise<ProviderView> {
    const current = this.require(id);
    const provider = this.build(current);

    let next: ProviderRecord;
    try {
      const models = await provider.listModels(signal);
      next = {
        ...current,
        discoveredModels: models.map((model) => model.id),
        connectionStatus: 'connected',
        lastCheckedAt: Date.now(),
        updatedAt: Date.now(),
      };
      delete next.lastError;
    } catch (error) {
      next = {
        ...current,
        connectionStatus: 'error',
        lastError: error instanceof Error ? error.message : String(error),
        lastCheckedAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    await this.commit([...this.records.values()].map((record) => (record.id === id ? next : record)));
    this.records.set(id, next);
    return this.toView(next);
  }

  private require(id: string): ProviderRecord {
    const record = this.records.get(id);
    if (!record) throw new ApiError(`provider '${id}' not found`, ErrorType.NotFound);
    return record;
  }

  private assertKind(kind: string): ProviderKindValue {
    if (!(kind in PROVIDER_KINDS)) {
      throw new ApiError(`unknown provider kind '${kind}'`, ErrorType.InvalidRequest);
    }
    return kind as ProviderKindValue;
  }

  private assertFreeId(id: string): string {
    if (!ID_PATTERN.test(id)) {
      throw new ApiError(
        'provider id must be 1-64 characters of letters, digits, dot, dash or underscore',
        ErrorType.InvalidRequest,
      );
    }
    if (this.records.has(id) || this.configIds.has(id)) {
      throw new ApiError(`provider '${id}' already exists`, ErrorType.InvalidRequest);
    }
    return id;
  }

  private seal(apiKey: string): string {
    if (!apiKey) return '';
    if (!this.cipher.available()) {
      throw new ApiError(
        'the OS keychain is unavailable, so an API key cannot be stored securely',
        ErrorType.ServiceUnavailable,
      );
    }
    return this.cipher.encrypt(apiKey);
  }

  private build(record: ProviderRecord) {
    const apiKey = record.secret ? this.cipher.decrypt(record.secret) : '';
    if (record.secret && apiKey === undefined) {
      throw new ApiError(
        `the stored API key for '${record.id}' cannot be decrypted; re-enter it`,
        ErrorType.Authentication,
      );
    }
    // The record keeps the URL the user gave; the adapter needs it without the
    // version segment it appends itself.
    return createProvider(record.kind, { baseUrl: adapterBaseUrl(record.baseUrl), apiKey });
  }

  /**
   * Puts the provider into the Router, or takes it out when it is disabled or
   * its key is unreadable — a provider that cannot serve a request must not be
   * routable, or `/v1/models` fails as a whole.
   */
  private mount(record: ProviderRecord): void {
    if (!record.enabled) {
      this.router.unregister(record.id);
      return;
    }
    try {
      this.router.register({ id: record.id, provider: this.build(record) });
    } catch {
      this.router.unregister(record.id);
    }
  }

  private async commit(records: ProviderRecord[]): Promise<void> {
    await this.store.save({ version: 1, providers: records });
  }

  /**
   * `hasApiKey` reports a key this build can actually decrypt. A key written by
   * a different keychain entry — a dev run versus a packaged app — reads as
   * absent, which is what the user has to act on: re-enter it.
   */
  private toView(record: ProviderRecord): ProviderView {
    const readable = !record.secret || this.cipher.decrypt(record.secret) !== undefined;
    return { ...toView(record), hasApiKey: Boolean(record.secret) && readable };
  }

}

function toView(record: ProviderRecord): ProviderView {
  const view: ProviderView = {
    id: record.id,
    name: record.name,
    kind: record.kind,
    baseUrl: record.baseUrl,
    hasApiKey: Boolean(record.secret),
    enabled: record.enabled,
    model: record.model,
    discoveredModels: record.discoveredModels,
    connectionStatus: record.connectionStatus,
    source: 'user',
    readOnly: false,
  };
  if (record.lastError !== undefined) view.lastError = record.lastError;
  if (record.lastCheckedAt !== undefined) view.lastCheckedAt = record.lastCheckedAt;
  return view;
}

function assertName(name: string): string {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) throw new ApiError('provider name is required', ErrorType.InvalidRequest);
  if (trimmed.length > 100) {
    throw new ApiError('provider name must be 100 characters or fewer', ErrorType.InvalidRequest);
  }
  return trimmed;
}
