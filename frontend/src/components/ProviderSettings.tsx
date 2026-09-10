import { useState } from 'react';
import { ApiError, fetchModels } from '../lib/api.ts';
import { PROVIDER_PRESETS, isProviderRoutable, providerKindLabel, validateProviderBaseUrl, visionModelIds } from '../lib/providers.ts';
import { useSettings } from '../store/useSettings.ts';
import {
  configuredModelCapability,
  DEFAULT_VISION_MODEL,
  modelRouteKey,
  testVisionRoute,
} from '../lib/vision.ts';
import type { ModelCapability, Provider } from '../types.ts';
import { IconPlus, IconSpinner, IconTrash } from './Icons';

type ProviderDraft = Omit<Provider, 'id'>;

const EMPTY: ProviderDraft = {
  name: '',
  kind: 'openai-compatible',
  baseUrl: '',
  authKind: 'bearer',
  apiKey: '',
  enabled: true,
  model: '',
  discoveredModels: [],
  visionModels: [],
  connectionStatus: 'untested',
};

function connectionError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Network error — check the URL and local service.';
  return error instanceof Error ? error.message : 'Connection failed';
}

/** A managed provider's key is server-side, so `hasApiKey` stands in for it. */
function needsKey(provider: Provider): boolean {
  if (provider.authKind !== 'bearer') return false;
  return provider.ownership === 'managed' ? provider.hasApiKey !== true : !provider.apiKey;
}

function statusStyle(provider: Provider): string {
  if (needsKey(provider)) return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
  if (!provider.enabled) return 'bg-surface-100 text-surface-500 dark:bg-surface-700';
  if (provider.connectionStatus === 'connected') return 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300';
  if (provider.connectionStatus === 'error') return 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
}

function statusLabel(provider: Provider): string {
  if (!provider.enabled) return 'Disabled';
  if (needsKey(provider)) return 'Needs API key';
  if (provider.connectionStatus === 'connected') return 'Connected';
  if (provider.connectionStatus === 'error') return 'Needs attention';
  if (provider.connectionStatus === 'testing') return 'Checking';
  return 'Not tested';
}

export default function ProviderSettings() {
  const settings = useSettings((state) => state.settings);
  const update = useSettings((state) => state.update);
  const providerBackend = useSettings((state) => state.providerBackend);
  const addProvider = useSettings((state) => state.addProvider);
  const updateProvider = useSettings((state) => state.updateProvider);
  const removeProvider = useSettings((state) => state.removeProvider);
  const setActiveProvider = useSettings((state) => state.setActiveProvider);
  const refreshProvider = useSettings((state) => state.refreshProvider);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [visionTesting, setVisionTesting] = useState(false);
  const [visionFeedback, setVisionFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const routableProviders = settings.providers.filter(isProviderRoutable);
  const visionProvider = routableProviders.find((provider) => provider.id === settings.visionProviderId) ?? null;
  const visionModels = visionProvider
    ? Array.from(new Set([visionProvider.model, ...visionProvider.discoveredModels].filter(Boolean)))
    : [];
  const activeProvider = routableProviders.find((provider) => provider.id === settings.activeProviderId)
    ?? routableProviders[0]
    ?? null;
  const activeCapabilityOverride = activeProvider
    ? settings.modelCapabilityOverrides[modelRouteKey(activeProvider.id, activeProvider.model)] ?? 'auto'
    : 'auto';
  const activeCapability = activeProvider
    ? configuredModelCapability(settings, activeProvider)
    : 'text-only';

  const managed = providerBackend === 'desktop';

  const beginAdd = () => {
    setEditingId(null);
    setDraft({ ...EMPTY });
    setFeedback(null);
  };

  const beginEdit = (provider: Provider) => {
    setEditingId(provider.id);
    setDraft({ ...provider, apiKey: '' });
    setFeedback(null);
  };

  const applyPreset = (preset: (typeof PROVIDER_PRESETS)[number]) => {
    setDraft((current) => ({
      ...(current ?? EMPTY),
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      authKind: preset.authKind,
      model: preset.model,
      apiKey: preset.authKind === 'none' ? '' : (current?.apiKey ?? ''),
      connectionStatus: 'untested',
      discoveredModels: [],
      visionModels: [],
      lastCheckedAt: undefined,
      lastError: undefined,
    }));
  };

  const probe = async (provider: Provider) => {
    const items = await fetchModels(provider);
    return {
      discoveredModels: Array.from(new Set(items.map((model) => model.id))).sort(),
      visionModels: Array.from(new Set(visionModelIds(items))).sort(),
    };
  };

  const checkSaved = async (provider: Provider) => {
    setTestingId(provider.id);
    try {
      if (provider.ownership === 'managed') {
        // The key lives in the main process, so the probe runs there too.
        await refreshProvider(provider.id);
        return;
      }
      await updateProvider(provider.id, { connectionStatus: 'testing', lastError: undefined });
      const catalog = await probe(provider);
      await updateProvider(provider.id, {
        connectionStatus: 'connected',
        ...catalog,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      });
    } catch (error) {
      await updateProvider(provider.id, {
        connectionStatus: 'error',
        lastCheckedAt: Date.now(),
        lastError: connectionError(error),
      });
    } finally {
      setTestingId(null);
    }
  };

  /**
   * Managed providers are saved before being probed: the desktop holds the key,
   * so there is nothing to test against until the record exists. Local
   * providers keep the older order, probing the draft first.
   */
  const saveManaged = async (testFirst: boolean) => {
    if (!draft) return;
    const payload = {
      ...draft,
      name: draft.name.trim() || draft.baseUrl,
      baseUrl: draft.baseUrl.trim().replace(/\/$/, ''),
      model: draft.model.trim(),
    };

    let id: string;
    try {
      if (editingId) {
        await updateProvider(editingId, payload);
        id = editingId;
      } else {
        id = await addProvider(payload);
      }
    } catch (error) {
      setFeedback({ ok: false, message: connectionError(error) });
      return;
    }

    if (testFirst) {
      setTestingId(id);
      try {
        await refreshProvider(id);
        const saved = useSettings.getState().settings.providers.find((provider) => provider.id === id);
        if (saved?.connectionStatus === 'error') {
          setFeedback({ ok: false, message: saved.lastError ?? 'Connection failed' });
          return;
        }
        setFeedback({
          ok: true,
          message: `Connected — ${saved?.discoveredModels.length ?? 0} models available.`,
        });
      } catch (error) {
        setFeedback({ ok: false, message: connectionError(error) });
        return;
      } finally {
        setTestingId(null);
      }
    }

    setDraft(null);
    setEditingId(null);
    setFeedback(null);
  };

  const save = async (testFirst: boolean) => {
    if (!draft?.baseUrl.trim() || !draft.model.trim()) return;
    const urlError = validateProviderBaseUrl(draft.baseUrl);
    if (urlError) {
      setFeedback({ ok: false, message: urlError });
      return;
    }
    setFeedback(null);
    if (managed) return saveManaged(testFirst);

    const existing = settings.providers.find((provider) => provider.id === editingId);
    const provider: Provider = {
      ...draft,
      id: editingId ?? 'probe',
      name: draft.name.trim() || draft.baseUrl,
      baseUrl: draft.baseUrl.trim().replace(/\/$/, ''),
      apiKey: draft.apiKey || existing?.apiKey || '',
      model: draft.model.trim(),
      connectionStatus: testFirst ? 'testing' : draft.connectionStatus,
      lastError: undefined,
    };

    if (testFirst) {
      setTestingId(provider.id);
      try {
        const catalog = await probe(provider);
        provider.discoveredModels = catalog.discoveredModels;
        provider.visionModels = catalog.visionModels;
        provider.connectionStatus = 'connected';
        provider.lastCheckedAt = Date.now();
        setFeedback({ ok: true, message: `Connected — ${provider.discoveredModels.length} models available.` });
      } catch (error) {
        provider.connectionStatus = 'error';
        provider.lastCheckedAt = Date.now();
        provider.lastError = connectionError(error);
        setFeedback({ ok: false, message: provider.lastError });
        setTestingId(null);
        return;
      }
      setTestingId(null);
    }

    if (editingId) {
      const { id: _id, ...patch } = provider;
      await updateProvider(editingId, patch);
    } else {
      const { id: _id, ...newProvider } = provider;
      const id = await addProvider(newProvider);
      if (newProvider.enabled && !settings.providers.some((item) => item.enabled)) await setActiveProvider(id);
    }
    setDraft(null);
    setEditingId(null);
    setFeedback(null);
  };

  const toggleProvider = async (provider: Provider) => {
    await updateProvider(provider.id, { enabled: !provider.enabled });
  };

  const deleteProvider = async (provider: Provider) => {
    const warning = provider.ownership === 'managed'
      ? `Delete ${provider.name}? Its API key will be removed from the system keychain.`
      : `Delete ${provider.name}? The saved API key and model catalog will be removed.`;
    if (confirm(warning)) {
      await removeProvider(provider.id);
      if (editingId === provider.id) setDraft(null);
    }
  };

  const selectVisionProvider = async (providerId: string) => {
    const provider = routableProviders.find((candidate) => candidate.id === providerId);
    if (!provider) {
      await update({ visionProviderId: null });
      return;
    }
    const models = Array.from(new Set([provider.model, ...provider.discoveredModels].filter(Boolean)));
    const shortDefault = DEFAULT_VISION_MODEL.split('/').at(-1)!;
    const preferred = models.find((model) =>
      model === DEFAULT_VISION_MODEL
      || model === shortDefault
      || model.endsWith(`/${DEFAULT_VISION_MODEL}`))
      ?? provider.visionModels[0]
      ?? provider.model;
    await update({ visionProviderId: provider.id, visionModel: preferred });
    setVisionFeedback(null);
  };

  const setActiveCapability = async (value: ModelCapability) => {
    if (!activeProvider) return;
    const key = modelRouteKey(activeProvider.id, activeProvider.model);
    const overrides = { ...settings.modelCapabilityOverrides };
    if (value === 'auto') delete overrides[key];
    else overrides[key] = value;
    await update({ modelCapabilityOverrides: overrides });
  };

  const testVision = async () => {
    setVisionTesting(true);
    setVisionFeedback(null);
    const started = performance.now();
    try {
      const analysis = await testVisionRoute(useSettings.getState().settings);
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      const cost = analysis.cost === undefined ? 'usage unavailable' : `$${analysis.cost.toFixed(8)}`;
      setVisionFeedback({ ok: true, message: `Image read correctly in ${elapsed}s · ${cost}.` });
    } catch (error) {
      setVisionFeedback({ ok: false, message: connectionError(error) });
    } finally {
      setVisionTesting(false);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">Providers</h3>
          <p className="mt-1 text-xs leading-5 text-surface-700/60 dark:text-surface-200/40">
            {managed
              ? 'Each provider is a separate route. API keys are encrypted by the system keychain and never leave this machine.'
              : 'Each provider is a separate route. API keys stay in this desktop browser profile and exports omit them.'}
          </p>
        </div>
        {!draft && <button onClick={beginAdd} className="btn-primary shrink-0"><IconPlus className="h-4 w-4" /> Add</button>}
      </div>

      <div className="space-y-2">
        {settings.providers.map((provider) => (
          <article key={provider.id} className={`rounded-xl border p-3 ${settings.activeProviderId === provider.id ? 'border-accent' : 'border-surface-200 dark:border-surface-700'} ${provider.enabled ? '' : 'opacity-70'}`}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                name="active-provider"
                checked={settings.activeProviderId === provider.id}
                disabled={!provider.enabled}
                onChange={() => void setActiveProvider(provider.id)}
                className="mt-1 h-4 w-4 shrink-0 accent-surface-900 dark:accent-surface-100"
                aria-label={`Use ${provider.name}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{provider.name}</span>
                  <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-600 dark:bg-surface-700 dark:text-surface-300">{providerKindLabel(provider.kind)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${statusStyle(provider)}`}>{statusLabel(provider)}</span>
                  {provider.readOnly && <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-600 dark:bg-surface-700 dark:text-surface-300">From config file</span>}
                </div>
                <p className="mt-1 truncate text-xs text-surface-700/60 dark:text-surface-200/40">
                  {provider.readOnly ? 'Configured in config.yaml' : `${provider.model} via ${provider.baseUrl}`}
                </p>
                {provider.lastError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{provider.lastError}</p>}
                {provider.discoveredModels.length > 1 && <p className="mt-1 text-[11px] text-surface-500">{provider.discoveredModels.length} models discovered</p>}
              </div>
              {!provider.readOnly && <button onClick={() => void toggleProvider(provider)} className="btn-ghost !px-2 text-xs">{provider.enabled ? 'Disable' : 'Enable'}</button>}
            </div>
            {!provider.readOnly && (
              <div className="mt-2 flex flex-wrap gap-2 pl-7">
                <button onClick={() => beginEdit(provider)} className="btn-ghost !px-2 text-xs">Configure</button>
                <button disabled={!provider.enabled || testingId === provider.id} onClick={() => void checkSaved(provider)} className="btn-ghost !px-2 text-xs">
                  {testingId === provider.id && <IconSpinner className="h-3.5 w-3.5" />} Test &amp; refresh
                </button>
                <button onClick={() => void deleteProvider(provider)} className="btn-ghost !px-2 text-xs hover:text-red-600" aria-label={`Delete ${provider.name}`}><IconTrash className="h-3.5 w-3.5" /> Delete</button>
              </div>
            )}
          </article>
        ))}
        {!settings.providers.length && <p className="rounded-xl border border-dashed border-surface-200 px-3 py-6 text-center text-sm text-surface-500 dark:border-surface-700">No provider connections.</p>}
      </div>

      {draft && (
        <div className="mt-3 space-y-3 rounded-xl border border-surface-200 p-4 dark:border-surface-700">
          <div className="flex items-center justify-between"><h4 className="text-sm font-semibold">{editingId ? 'Configure provider' : 'Add provider'}</h4><span className="text-xs text-surface-500">{providerKindLabel(draft.kind)}</span></div>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_PRESETS.map((preset) => <button key={preset.id} onClick={() => applyPreset(preset)} className="rounded-full border border-surface-200 px-2.5 py-1 text-xs hover:border-accent hover:text-accent dark:border-surface-700">{preset.name}</button>)}
          </div>
          <div><label className="label" htmlFor="provider-name">Name</label><input id="provider-name" className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="DeepSeek direct" /></div>
          <div><label className="label" htmlFor="provider-url">Base URL</label><input id="provider-url" className="input" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value, connectionStatus: 'untested' })} placeholder="https://api.example.com/v1" /><p className="hint">OpenAI-compatible URL including /v1.</p></div>
          <div>
            <label className="label" htmlFor="provider-auth">Authorization</label>
            <select id="provider-auth" className="input" value={draft.authKind} onChange={(event) => setDraft({ ...draft, authKind: event.target.value as ProviderDraft['authKind'], apiKey: event.target.value === 'none' ? '' : draft.apiKey })}><option value="bearer">Bearer API key</option><option value="none">No authorization</option></select>
          </div>
          {draft.authKind === 'bearer' && (
            <div>
              <label className="label" htmlFor="provider-key">API key</label>
              <input id="provider-key" type="password" className="input" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, connectionStatus: 'untested' })} placeholder={editingId ? 'Leave blank to keep current key' : 'Required by provider'} autoComplete="off" />
              {managed && <p className="hint">Stored in the system keychain by the desktop app, not in this browser profile.</p>}
            </div>
          )}
          <div><label className="label" htmlFor="provider-model">Default model</label><input id="provider-model" className="input" list="provider-models" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="model-id" /><datalist id="provider-models">{draft.discoveredModels.map((model) => <option key={model} value={model} />)}</datalist></div>
          {feedback && <p role="status" className={feedback.ok ? 'text-xs text-green-600 dark:text-green-400' : 'text-xs text-red-600 dark:text-red-400'}>{feedback.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void save(true)} disabled={!draft.baseUrl.trim() || !draft.model.trim() || testingId !== null} className="btn-primary">{testingId && <IconSpinner className="h-4 w-4" />} Test &amp; save</button>
            <button onClick={() => void save(false)} disabled={!draft.baseUrl.trim() || !draft.model.trim()} className="btn-ghost border border-surface-200 dark:border-surface-700">Save without testing</button>
            <button onClick={() => { setDraft(null); setEditingId(null); setFeedback(null); }} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}

      <div className="mt-6 border-t border-surface-200 pt-5 dark:border-surface-700">
        <h4 className="text-sm font-semibold">Vision fallback</h4>
        <p className="mt-1 text-xs leading-5 text-surface-500">
          When the destination model is text-only or unknown, images are analyzed by this route first.
          The composer shows the second provider before anything is sent.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="vision-provider">Provider</label>
            <select
              id="vision-provider"
              className="input"
              value={settings.visionProviderId ?? ''}
              onChange={(event) => void selectVisionProvider(event.target.value)}
            >
              <option value="">Not configured</option>
              {routableProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="vision-model">Vision model</label>
            <input
              id="vision-model"
              className="input"
              list="vision-models"
              disabled={!visionProvider}
              value={settings.visionModel}
              onChange={(event) => void update({ visionModel: event.target.value })}
              placeholder={DEFAULT_VISION_MODEL}
            />
            <datalist id="vision-models">
              {visionModels.map((model) => <option key={model} value={model} />)}
            </datalist>
          </div>
        </div>
        {activeProvider && (
          <div className="mt-3">
            <label className="label" htmlFor="active-model-capability">
              {activeProvider.name} · {activeProvider.model} image capability
            </label>
            <select
              id="active-model-capability"
              className="input"
              value={activeCapabilityOverride}
              onChange={(event) => void setActiveCapability(event.target.value as ModelCapability)}
            >
              <option value="auto">Auto ({activeCapability === 'vision' ? 'Vision from metadata' : 'unknown → text-only'})</option>
              <option value="vision">Vision</option>
              <option value="text-only">Text-only</option>
            </select>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={!visionProvider || !settings.visionModel.trim() || visionTesting}
            onClick={() => void testVision()}
          >
            {visionTesting && <IconSpinner className="h-4 w-4" />}
            Test with image
          </button>
          {visionFeedback && (
            <p role="status" className={visionFeedback.ok ? 'text-xs text-green-600 dark:text-green-400' : 'text-xs text-red-600 dark:text-red-400'}>
              {visionFeedback.message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
