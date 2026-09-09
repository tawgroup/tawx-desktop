import { useState } from 'react';
import { ApiError, fetchModels } from '../lib/api.ts';
import { PROVIDER_PRESETS, providerKindLabel, validateProviderBaseUrl } from '../lib/providers.ts';
import { useSettings } from '../store/useSettings.ts';
import type { Provider } from '../types.ts';
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
  connectionStatus: 'untested',
};

function connectionError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Network error — check the URL and local service.';
  return error instanceof Error ? error.message : 'Connection failed';
}

function statusStyle(provider: Provider): string {
  if (provider.authKind === 'bearer' && !provider.apiKey) return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
  if (!provider.enabled) return 'bg-surface-100 text-surface-500 dark:bg-surface-700';
  if (provider.connectionStatus === 'connected') return 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300';
  if (provider.connectionStatus === 'error') return 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300';
  return 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
}

function statusLabel(provider: Provider): string {
  if (!provider.enabled) return 'Disabled';
  if (provider.authKind === 'bearer' && !provider.apiKey) return 'Needs API key';
  if (provider.connectionStatus === 'connected') return 'Connected';
  if (provider.connectionStatus === 'error') return 'Needs attention';
  if (provider.connectionStatus === 'testing') return 'Checking';
  return 'Not tested';
}

export default function ProviderSettings() {
  const settings = useSettings((state) => state.settings);
  const addProvider = useSettings((state) => state.addProvider);
  const updateProvider = useSettings((state) => state.updateProvider);
  const removeProvider = useSettings((state) => state.removeProvider);
  const setActiveProvider = useSettings((state) => state.setActiveProvider);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

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
      lastCheckedAt: undefined,
      lastError: undefined,
    }));
  };

  const probe = async (provider: Provider): Promise<string[]> => {
    const models = (await fetchModels(provider)).map((model) => model.id).sort();
    return Array.from(new Set(models));
  };

  const checkSaved = async (provider: Provider) => {
    setTestingId(provider.id);
    await updateProvider(provider.id, { connectionStatus: 'testing', lastError: undefined });
    try {
      const discoveredModels = await probe(provider);
      await updateProvider(provider.id, {
        connectionStatus: 'connected',
        discoveredModels,
        lastCheckedAt: Date.now(),
        lastError: undefined,
      });
    } catch (error) {
      const lastError = connectionError(error);
      await updateProvider(provider.id, {
        connectionStatus: 'error',
        lastCheckedAt: Date.now(),
        lastError,
      });
    } finally {
      setTestingId(null);
    }
  };

  const save = async (testFirst: boolean) => {
    if (!draft?.baseUrl.trim() || !draft.model.trim()) return;
    const urlError = validateProviderBaseUrl(draft.baseUrl);
    if (urlError) {
      setFeedback({ ok: false, message: urlError });
      return;
    }
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

    setFeedback(null);
    if (testFirst) {
      setTestingId(provider.id);
      try {
        provider.discoveredModels = await probe(provider);
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
    if (confirm(`Delete ${provider.name}? The saved API key and model catalog will be removed.`)) {
      await removeProvider(provider.id);
      if (editingId === provider.id) setDraft(null);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">Providers</h3>
          <p className="mt-1 text-xs leading-5 text-surface-700/60 dark:text-surface-200/40">
            Each provider is a separate route. API keys stay in this desktop browser profile and exports omit them.
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
                </div>
                <p className="mt-1 truncate text-xs text-surface-700/60 dark:text-surface-200/40">{provider.model} via {provider.baseUrl}</p>
                {provider.lastError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{provider.lastError}</p>}
                {provider.discoveredModels.length > 1 && <p className="mt-1 text-[11px] text-surface-500">{provider.discoveredModels.length} models discovered</p>}
              </div>
              <button onClick={() => void toggleProvider(provider)} className="btn-ghost !px-2 text-xs">{provider.enabled ? 'Disable' : 'Enable'}</button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 pl-7">
              <button onClick={() => beginEdit(provider)} className="btn-ghost !px-2 text-xs">Configure</button>
              <button disabled={!provider.enabled || testingId === provider.id} onClick={() => void checkSaved(provider)} className="btn-ghost !px-2 text-xs">
                {testingId === provider.id && <IconSpinner className="h-3.5 w-3.5" />} Test & refresh
              </button>
              <button onClick={() => void deleteProvider(provider)} className="btn-ghost !px-2 text-xs hover:text-red-600" aria-label={`Delete ${provider.name}`}><IconTrash className="h-3.5 w-3.5" /> Delete</button>
            </div>
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
          {draft.authKind === 'bearer' && <div><label className="label" htmlFor="provider-key">API key</label><input id="provider-key" type="password" className="input" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, connectionStatus: 'untested' })} placeholder={editingId ? 'Leave blank to keep current key' : 'Required by provider'} autoComplete="off" /></div>}
          <div><label className="label" htmlFor="provider-model">Default model</label><input id="provider-model" className="input" list="provider-models" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="model-id" /><datalist id="provider-models">{draft.discoveredModels.map((model) => <option key={model} value={model} />)}</datalist></div>
          {feedback && <p role="status" className={feedback.ok ? 'text-xs text-green-600 dark:text-green-400' : 'text-xs text-red-600 dark:text-red-400'}>{feedback.message}</p>}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void save(true)} disabled={!draft.baseUrl.trim() || !draft.model.trim() || testingId !== null} className="btn-primary">{testingId && <IconSpinner className="h-4 w-4" />} Test & save</button>
            <button onClick={() => void save(false)} disabled={!draft.baseUrl.trim() || !draft.model.trim()} className="btn-ghost border border-surface-200 dark:border-surface-700">Save without testing</button>
            <button onClick={() => { setDraft(null); setEditingId(null); setFeedback(null); }} className="btn-ghost">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
