import { create } from 'zustand';
import type { Provider, Settings } from '../types';
import { DEFAULT_SETTINGS } from '../types.ts';
import { ApiError } from '../lib/api.ts';
import { clearAll, loadSettings, saveSettings } from '../lib/db.ts';
import { uid } from '../lib/utils.ts';
import { isProviderRoutable, resolveProviderCall } from '../lib/providers.ts';
import {
  createProvider as createRemoteProvider,
  deleteProvider as deleteRemoteProvider,
  listProviders,
  patchProvider,
  providersSupported,
  testProvider,
  type RemoteProvider,
} from '../lib/providerApi.ts';

/**
 * Where provider records live. `desktop` means the main process owns them and
 * their keys; `local` means this browser profile does, which is the only option
 * when the bundle is served by the Go gateway.
 */
export type ProviderBackend = 'unknown' | 'desktop' | 'local';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  providerBackend: ProviderBackend;
  hydrate: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  addProvider: (provider: Omit<Provider, 'id'>) => Promise<string>;
  updateProvider: (id: string, patch: Partial<Provider>) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setActiveProvider: (id: string | null) => Promise<void>;
  /** Probes a managed provider server-side; returns the refreshed record. */
  refreshProvider: (id: string) => Promise<void>;
  activeProvider: () => Provider | null;
  wipe: () => Promise<void>;
}

/** The synthetic entry that routes by the gateway's own model resolution. */
const isGateway = (provider: Provider) => provider.kind === 'gateway';

function fromRemote(remote: RemoteProvider): Provider {
  const provider: Provider = {
    id: remote.id,
    name: remote.name,
    kind: remote.kind,
    baseUrl: remote.baseUrl,
    authKind: remote.hasApiKey ? 'bearer' : 'none',
    apiKey: '',
    enabled: remote.enabled,
    model: remote.model,
    discoveredModels: remote.discoveredModels,
    connectionStatus: remote.connectionStatus,
    ownership: 'managed',
    readOnly: remote.readOnly,
    hasApiKey: remote.hasApiKey,
  };
  if (remote.lastError !== undefined) provider.lastError = remote.lastError;
  if (remote.lastCheckedAt !== undefined) provider.lastCheckedAt = remote.lastCheckedAt;
  return provider;
}

/**
 * Moves providers held in this browser profile into the main process, once.
 *
 * The key is only cleared locally after the server has accepted it, so an
 * interrupted migration leaves the key where it still works rather than losing
 * it. Re-running is safe: an id the server already holds comes back as a
 * conflict, which means the record moved on an earlier pass.
 */
async function migrateLocalProviders(local: Provider[]): Promise<Provider[]> {
  const movable = local.filter((provider) => !isGateway(provider) && provider.ownership !== 'managed');
  if (!movable.length) return local;

  const migrated = new Set<string>();
  for (const provider of movable) {
    try {
      await createRemoteProvider({
        id: provider.id,
        name: provider.name,
        kind: provider.kind === 'gateway' ? 'openai-compatible' : provider.kind,
        baseUrl: provider.baseUrl,
        ...(provider.apiKey && provider.apiKey !== 'not-needed' ? { apiKey: provider.apiKey } : {}),
        enabled: provider.enabled,
        model: provider.model,
      });
      migrated.add(provider.id);
    } catch (error) {
      // A conflict means an earlier pass already moved this record, so the
      // local copy is safe to drop. Any other refusal — an invalid URL, no
      // keychain — must leave the record here rather than delete a provider
      // the server never accepted.
      if (error instanceof ApiError && /already exists/i.test(error.message)) {
        migrated.add(provider.id);
      }
    }
  }

  // Keep only the gateway entry locally; the rest now belong to the server, and
  // leaving a copy behind would leave its key in IndexedDB.
  return local.filter((provider) => isGateway(provider) || !migrated.has(provider.id));
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  providerBackend: 'unknown',

  hydrate: async () => {
    const stored = await loadSettings();
    const desktop = await providersSupported();

    if (!desktop) {
      set({ settings: stored, loaded: true, providerBackend: 'local' });
      applyAppearance(stored);
      return;
    }

    const remaining = await migrateLocalProviders(stored.providers);
    if (remaining.length !== stored.providers.length) {
      await saveSettings({ ...stored, providers: remaining });
    }

    const managed = (await listProviders()).map(fromRemote);
    const providers = [...remaining.filter(isGateway), ...managed];
    const active =
      providers.find((provider) => provider.id === stored.activeProviderId && isProviderRoutable(provider))
      ?? providers.find(isProviderRoutable);
    const settings: Settings = { ...stored, providers, activeProviderId: active?.id ?? '' };

    set({ settings, loaded: true, providerBackend: 'desktop' });
    applyAppearance(settings);
  },

  update: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (patch.theme || patch.contentFont || patch.contentSize) applyAppearance(settings);
    await persist(settings);
  },

  addProvider: async (provider) => {
    if (get().providerBackend === 'desktop') {
      const created = fromRemote(
        await createRemoteProvider({
          name: provider.name,
          kind: provider.kind === 'gateway' ? 'openai-compatible' : provider.kind,
          baseUrl: provider.baseUrl,
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
          enabled: provider.enabled,
          model: provider.model,
        }),
      );
      const { settings } = get();
      const next: Settings = {
        ...settings,
        providers: [...settings.providers, created],
        activeProviderId: settings.activeProviderId || (isProviderRoutable(created) ? created.id : ''),
      };
      set({ settings: next });
      await persist(next);
      return created.id;
    }

    const id = uid();
    const { settings } = get();
    const next: Settings = {
      ...settings,
      providers: [...settings.providers, { ...provider, id }],
      // First enabled provider added becomes active automatically.
      activeProviderId: settings.activeProviderId || (isProviderRoutable({ ...provider, id }) ? id : ''),
    };
    set({ settings: next });
    await persist(next);
    return id;
  },

  updateProvider: async (id, patch) => {
    const { settings, providerBackend } = get();
    const current = settings.providers.find((provider) => provider.id === id);

    let applied: Partial<Provider> = patch;
    if (providerBackend === 'desktop' && current?.ownership === 'managed') {
      applied = fromRemote(
        await patchProvider(id, {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.kind !== undefined && patch.kind !== 'gateway' && { kind: patch.kind }),
          ...(patch.baseUrl !== undefined && { baseUrl: patch.baseUrl }),
          // An empty apiKey in a patch means "unchanged" here, matching the
          // form's "leave blank to keep current key" placeholder.
          ...(patch.apiKey ? { apiKey: patch.apiKey } : {}),
          ...(patch.enabled !== undefined && { enabled: patch.enabled }),
          ...(patch.model !== undefined && { model: patch.model }),
        }),
      );
    }

    const providers = settings.providers.map((provider) =>
      provider.id === id ? { ...provider, ...applied } : provider,
    );
    const updated = providers.find((provider) => provider.id === id)!;
    const activeProviderId =
      settings.activeProviderId === id && !isProviderRoutable(updated)
        ? (providers.find(isProviderRoutable)?.id ?? '')
        : settings.activeProviderId;
    const next: Settings = { ...settings, providers, activeProviderId };
    set({ settings: next });
    await persist(next);
  },

  removeProvider: async (id) => {
    const { settings, providerBackend } = get();
    const current = settings.providers.find((provider) => provider.id === id);
    if (providerBackend === 'desktop' && current?.ownership === 'managed') {
      await deleteRemoteProvider(id);
    }

    const providers = settings.providers.filter((provider) => provider.id !== id);
    const next: Settings = {
      ...settings,
      providers,
      activeProviderId: settings.activeProviderId === id
        ? (providers.find(isProviderRoutable)?.id ?? '')
        : settings.activeProviderId,
    };
    set({ settings: next });
    await persist(next);
  },

  setActiveProvider: async (id) => {
    const { settings } = get();
    const provider = settings.providers.find((candidate) => candidate.id === id);
    if (id && (!provider || !isProviderRoutable(provider))) return;
    const next = { ...settings, activeProviderId: id };
    set({ settings: next });
    await persist(next);
  },

  refreshProvider: async (id) => {
    const refreshed = fromRemote(await testProvider(id));
    const { settings } = get();
    const providers = settings.providers.map((provider) =>
      provider.id === id ? refreshed : provider,
    );
    const next: Settings = { ...settings, providers };
    set({ settings: next });
    await persist(next);
  },

  activeProvider: () => {
    const { providers, activeProviderId } = get().settings;
    const provider =
      providers.find((candidate) => candidate.id === activeProviderId && isProviderRoutable(candidate))
      ?? providers.find(isProviderRoutable);
    // Managed providers are called through the gateway, not directly. The
    // rewrite happens here rather than in the stored list so Settings keeps
    // showing the real upstream URL.
    return provider ? resolveProviderCall(provider) : null;
  },

  wipe: async () => {
    await clearAll();
    set({ settings: DEFAULT_SETTINGS });
    applyAppearance(DEFAULT_SETTINGS);
  },
}));

/**
 * Managed providers are the server's state, not this profile's. Persisting them
 * locally would resurrect deleted providers on the next launch, so only the
 * gateway entry and genuinely local records are written.
 */
async function persist(settings: Settings): Promise<void> {
  await saveSettings({
    ...settings,
    providers: settings.providers.filter((provider) => provider.ownership !== 'managed'),
  });
}

/**
 * Reading is a third theme, not a variant of light: it swaps the surface ramp
 * (see index.css) so existing markup follows with no change. `dark` and
 * `reading` are therefore mutually exclusive — both at once would darken the
 * warm ramp through the markup's own `dark:` variants.
 */
/** Theme and message typography are always applied together. */
export function applyAppearance(settings: Settings): void {
  applyTheme(settings.theme);
  applyContentTypography(settings);
}

/**
 * Which classes belong on the root element. Separated from the DOM so the one
 * invariant that matters can be tested: `dark` and `reading` are never both
 * set. Reading swaps the surface ramp, and the markup picks its dark colours
 * through `dark:` variants, so the two together would darken twice.
 */
export function themeClasses(
  theme: Settings['theme'],
  prefersDark: boolean,
): { dark: boolean; reading: boolean } {
  if (theme === 'reading') return { dark: false, reading: true };
  return { dark: theme === 'dark' || (theme === 'system' && prefersDark), reading: false };
}

export function applyTheme(theme: Settings['theme']): void {
  const { dark, reading } = themeClasses(
    theme,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('reading', reading);
}

const CONTENT_SIZES: Record<Settings['contentSize'], { size: string; leading: string }> = {
  sm: { size: '14px', leading: '1.7' },
  md: { size: '15px', leading: '1.75' },
  lg: { size: '17px', leading: '1.8' },
  xl: { size: '19px', leading: '1.85' },
};

export const CONTENT_FONTS: Record<Settings['contentFont'], string> = {
  sans: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Charter, "Iowan Old Style", Palatino, Georgia, serif',
};

/** The values the root custom properties get. Pure, so it can be tested. */
export function contentTypography(
  settings: Pick<Settings, 'contentFont' | 'contentSize'>,
): { size: string; leading: string; font: string } {
  const { size, leading } = CONTENT_SIZES[settings.contentSize] ?? CONTENT_SIZES.md;
  return { size, leading, font: CONTENT_FONTS[settings.contentFont] ?? CONTENT_FONTS.sans };
}

/**
 * Message typography only. The UI chrome keeps one size so controls stay
 * predictable; use the View menu's zoom to scale everything.
 */
export function applyContentTypography(settings: Pick<Settings, 'contentFont' | 'contentSize'>): void {
  const { size, leading, font } = contentTypography(settings);
  const root = document.documentElement;
  root.style.setProperty('--content-size', size);
  root.style.setProperty('--content-leading', leading);
  root.style.setProperty('--content-font', font);
}
