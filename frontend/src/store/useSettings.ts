import { create } from 'zustand';
import type { Provider, Settings } from '../types';
import { DEFAULT_SETTINGS } from '../types.ts';
import { clearAll, loadSettings, saveSettings } from '../lib/db.ts';
import { uid } from '../lib/utils.ts';
import { isProviderRoutable } from '../lib/providers.ts';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  addProvider: (provider: Omit<Provider, 'id'>) => Promise<string>;
  updateProvider: (id: string, patch: Partial<Provider>) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setActiveProvider: (id: string | null) => Promise<void>;
  activeProvider: () => Provider | null;
  wipe: () => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  hydrate: async () => {
    const settings = await loadSettings();
    set({ settings, loaded: true });
    applyTheme(settings.theme);
  },

  update: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (patch.theme) applyTheme(patch.theme);
    await saveSettings(settings);
  },

  addProvider: async (provider) => {
    const id = uid();
    const { settings } = get();
    const next: Settings = {
      ...settings,
      providers: [...settings.providers, { ...provider, id }],
      // First enabled provider added becomes active automatically.
      activeProviderId: settings.activeProviderId || (isProviderRoutable({ ...provider, id }) ? id : ''),
    };
    set({ settings: next });
    await saveSettings(next);
    return id;
  },

  updateProvider: async (id, patch) => {
    const { settings } = get();
    const providers = settings.providers.map((provider) => (
      provider.id === id ? { ...provider, ...patch } : provider
    ));
    const activeProviderId = settings.activeProviderId === id && !isProviderRoutable(providers.find((provider) => provider.id === id)!)
      ? (providers.find(isProviderRoutable)?.id ?? '')
      : settings.activeProviderId;
    const next: Settings = { ...settings, providers, activeProviderId };
    set({ settings: next });
    await saveSettings(next);
  },

  removeProvider: async (id) => {
    const { settings } = get();
    const providers = settings.providers.filter((provider) => provider.id !== id);
    const next: Settings = {
      ...settings,
      providers,
      activeProviderId: settings.activeProviderId === id
        ? (providers.find(isProviderRoutable)?.id ?? '')
        : settings.activeProviderId,
    };
    set({ settings: next });
    await saveSettings(next);
  },

  setActiveProvider: async (id) => {
    const { settings } = get();
    const provider = settings.providers.find((candidate) => candidate.id === id);
    if (id && (!provider || !isProviderRoutable(provider))) return;
    const next = { ...settings, activeProviderId: id };
    set({ settings: next });
    await saveSettings(next);
  },

  activeProvider: () => {
    const { providers, activeProviderId } = get().settings;
    return providers.find((provider) => provider.id === activeProviderId && isProviderRoutable(provider))
      ?? providers.find(isProviderRoutable)
      ?? null;
  },

  wipe: async () => {
    await clearAll();
    set({ settings: DEFAULT_SETTINGS });
    applyTheme(DEFAULT_SETTINGS.theme);
  },
}));

export function applyTheme(theme: Settings['theme']): void {
  const root = document.documentElement;
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);
}
