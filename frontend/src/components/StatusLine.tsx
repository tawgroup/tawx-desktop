import { useEffect, useMemo, useState } from 'react';
import { useToolCapabilities } from '../store/useToolCapabilities';
import type { AppMode, ContextBudget, CoworkSection, CoworkTask, Provider, ThreadPolicy, Workspace } from '../types';

type ItemKey = 'state' | 'environment' | 'model' | 'context' | 'runtime' | 'more';

interface StatusLineProps {
  mode: AppMode;
  coworkSection: CoworkSection;
  task: CoworkTask | null;
  provider: Provider | null;
  budget: ContextBudget;
  workspace?: Workspace;
  policy: ThreadPolicy;
  onOpenContext: () => void;
  onOpenSettings: () => void;
}

function label(value: string) {
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export default function StatusLine({ mode, coworkSection, task, provider, budget, workspace, policy, onOpenContext, onOpenSettings }: StatusLineProps) {
  const [open, setOpen] = useState<ItemKey | null>(null);
  const runtime = useToolCapabilities((state) => state.status);
  const runtimeError = useToolCapabilities((state) => state.error);
  const loadRuntime = useToolCapabilities((state) => state.load);

  useEffect(() => {
    if (mode !== 'chat') void loadRuntime();
  }, [loadRuntime, mode]);
  useEffect(() => setOpen(null), [mode, coworkSection]);

  const used = budget.maxTokens > 0 ? Math.round((budget.usedTokens / budget.maxTokens) * 100) : 0;
  const contextTone = used >= 90 ? 'text-red-600 dark:text-red-400' : used >= 70 ? 'text-amber-600 dark:text-amber-400' : '';
  const state = mode === 'chat' ? 'Ready' : mode === 'cowork' && coworkSection !== 'tasks' ? label(coworkSection) : label(task?.status ?? 'idle');
  const model = mode === 'chat' ? provider?.model : task?.model ?? provider?.model;
  const environment = mode === 'chat' ? null : (task?.workspace ?? workspace)?.name;
  const runtimeLabel = mode === 'chat'
    ? (provider ? 'Provider ready' : 'Provider unavailable')
    : `Runtime ${runtime === 'connected' ? 'connected' : runtime}`;

  const items = useMemo(() => ({
    state: { compact: state, detail: mode === 'chat' ? 'Conversation is ready.' : `Current state: ${state}.` },
    environment: environment ? { compact: `${environment} · ${label(task?.policy ?? policy)}`, detail: `Workspace: ${environment}. Permission policy: ${label(task?.policy ?? policy)}.` } : null,
    model: model ? { compact: model.split('/').at(-1) ?? model, detail: `Model: ${model}${provider ? `. Provider: ${provider.name}.` : '.'}` } : null,
    context: { compact: `Context ${used}%`, detail: `${budget.usedTokens.toLocaleString()} of ${budget.maxTokens.toLocaleString()} tokens used. ${budget.remainingTokens.toLocaleString()} remain. ${budget.compactionCount} compactions.` },
    runtime: { compact: runtimeLabel, detail: mode === 'chat' ? (provider ? `${provider.name} is configured.` : 'No provider is configured.') : (runtimeError ?? `Desktop runtime is ${runtime}.`) },
  }), [budget, environment, mode, model, policy, provider, runtime, runtimeError, runtimeLabel, state, task, used]);

  const renderItem = (key: Exclude<ItemKey, 'more'>, extra = '') => {
    const item = items[key];
    if (!item) return null;
    return <div className={`relative ${extra}`} key={key}>
      <button type="button" onClick={() => setOpen(open === key ? null : key)} className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs hover:bg-surface-100 dark:hover:bg-surface-800 ${key === 'context' ? contextTone : ''}`} aria-expanded={open === key}>
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />{item.compact}
      </button>
      {open === key && <div role="dialog" className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border border-surface-200 bg-white p-3 text-xs leading-5 shadow-lg dark:border-surface-700 dark:bg-surface-900">
        <p>{item.detail}</p>
        {key === 'context' && <button className="mt-2 font-medium text-accent" onClick={onOpenContext}>Open Context Inspector</button>}
        {key === 'runtime' && mode === 'chat' && <button className="mt-2 font-medium text-accent" onClick={onOpenSettings}>Open Settings</button>}
      </div>}
    </div>;
  };

  const overflow = (['model', 'runtime'] as const).filter((key) => items[key]);
  return <footer className="safe-bottom flex h-9 shrink-0 items-center gap-1 border-t border-surface-200 bg-white px-2 text-surface-600 dark:border-surface-800 dark:bg-surface-950 dark:text-surface-300" aria-label="Status line">
    {renderItem('state')}
    {renderItem('environment')}
    {renderItem('model', 'hidden md:block')}
    {renderItem('context')}
    {renderItem('runtime', 'hidden md:block')}
    {overflow.length > 0 && <div className="relative md:hidden">
      <button type="button" onClick={() => setOpen(open === 'more' ? null : 'more')} className="h-7 rounded px-2 text-xs hover:bg-surface-100 dark:hover:bg-surface-800">More</button>
      {open === 'more' && <div role="dialog" className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-xl border border-surface-200 bg-white p-2 shadow-lg dark:border-surface-700 dark:bg-surface-900">
        {overflow.map((key) => <button key={key} className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-surface-100 dark:hover:bg-surface-800" onClick={() => setOpen(key)}>{items[key]?.compact}</button>)}
      </div>}
    </div>}
  </footer>;
}
