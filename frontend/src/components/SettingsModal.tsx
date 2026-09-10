import { useEffect, useRef, useState } from 'react';
import { useSettings } from '../store/useSettings';
import { useChats } from '../store/useChats';
import { exportData, importData } from '../lib/db';
import { IconClose } from './Icons';
import ProviderSettings from './ProviderSettings';

interface Props {
  open: boolean;
  onClose: () => void;
}


export default function SettingsModal({ open, onClose }: Props) {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const wipe = useSettings((s) => s.wipe);
  const hydrateChats = useChats((s) => s.hydrate);
  const selectChat = useChats((s) => s.selectChat);

  const [dataResult, setDataResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Escape closes the modal from anywhere inside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setDataResult(null);
  }, [open]);

  if (!open) return null;


  const doExport = async () => {
    const json = await exportData();
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatopenapi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async (file: File) => {
    try {
      await importData(await file.text());
      await hydrateChats();
      setDataResult({ ok: true, msg: 'Backup imported' });
    } catch (err) {
      setDataResult({ ok: false, msg: err instanceof Error ? err.message : 'Import failed' });
    }
  };

  const doWipe = async () => {
    if (!confirm('Delete all chats, messages and settings? This cannot be undone.')) return;
    await wipe();
    await hydrateChats();
    await selectChat(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-2xl bg-white
                   shadow-xl dark:bg-surface-800 sm:max-h-[85vh] sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-surface-100 px-5 py-4 dark:border-surface-700">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className="btn-ghost !px-2" aria-label="Close settings">
            <IconClose />
          </button>
        </header>

        <div className="scrollbar-thin flex-1 space-y-8 overflow-y-auto px-5 py-5">
          <ProviderSettings />

          {/* ── Generation ── */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">
              Generation
            </h3>

            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="sys">Default system prompt for new threads</label>
                <textarea
                  id="sys"
                  rows={3}
                  className="input resize-y"
                  placeholder="Set the standing instructions for new threads."
                  value={settings.systemPrompt}
                  onChange={(e) => void update({ systemPrompt: e.target.value })}
                />
                <p className="mt-1.5 text-xs leading-5 text-surface-500">
                  New threads save a snapshot. Existing snapshots never change with this default. A
                  legacy thread without a snapshot inherits it until that thread is next saved.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="temp">
                  Temperature: {settings.temperature.toFixed(2)}
                </label>
                <input
                  id="temp"
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => void update({ temperature: Number(e.target.value) })}
                  className="w-full accent-surface-900 dark:accent-surface-100"
                />
              </div>

              <div>
                <label className="label" htmlFor="maxtok">Max tokens</label>
                <input
                  id="maxtok"
                  type="number"
                  min={1}
                  className="input"
                  placeholder="Provider default"
                  value={settings.maxTokens ?? ''}
                  onChange={(e) =>
                    void update({ maxTokens: e.target.value ? Number(e.target.value) : null })
                  }
                />
              </div>

              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={settings.streaming}
                  onChange={(e) => void update({ streaming: e.target.checked })}
                  className="h-4 w-4 accent-surface-900 dark:accent-surface-100"
                />
                Stream responses
              </label>

              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={settings.sendOnEnter}
                  onChange={(e) => void update({ sendOnEnter: e.target.checked })}
                  className="h-4 w-4 accent-surface-900 dark:accent-surface-100"
                />
                Enter sends message
              </label>
            </div>
          </section>

          {/* ── Appearance ── */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">
              Appearance
            </h3>
            <div className="flex gap-2">
              {(['light', 'dark', 'system', 'reading'] as const).map((theme) => (
                <button
                  key={theme}
                  onClick={() => void update({ theme })}
                  className={
                    settings.theme === theme
                      ? 'btn-primary flex-1 capitalize'
                      : 'btn-ghost flex-1 border border-surface-200 capitalize dark:border-surface-700'
                  }
                >
                  {theme}
                </button>
              ))}
            </div>

            <div className="mt-3">
              <label className="label">Message text</label>
              <div className="flex gap-2">
                {([
                  ['sm', 'Small'],
                  ['md', 'Medium'],
                  ['lg', 'Large'],
                  ['xl', 'Larger'],
                ] as const).map(([size, label]) => (
                  <button
                    key={size}
                    onClick={() => void update({ contentSize: size })}
                    className={
                      settings.contentSize === size
                        ? 'btn-primary flex-1'
                        : 'btn-ghost flex-1 border border-surface-200 dark:border-surface-700'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="hint">Applies to messages only. Use View &gt; Zoom to scale the whole app.</p>
            </div>

            <div className="mt-3">
              <label className="label">Message typeface</label>
              <div className="flex gap-2">
                {([
                  ['sans', 'Sans'],
                  ['serif', 'Serif'],
                ] as const).map(([font, label]) => (
                  <button
                    key={font}
                    onClick={() => void update({ contentFont: font })}
                    className={
                      settings.contentFont === font
                        ? 'btn-primary flex-1'
                        : 'btn-ghost flex-1 border border-surface-200 dark:border-surface-700'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ── Data ── */}
          <section>
            <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">
              Data
            </h3>
            <p className="mb-3 text-xs text-surface-700/60 dark:text-surface-200/40">
              Everything lives in this browser's IndexedDB. Exports omit API keys.
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void doExport()} className="btn-ghost border border-surface-200 dark:border-surface-700">
                Export backup
              </button>
              <button onClick={() => fileRef.current?.click()} className="btn-ghost border border-surface-200 dark:border-surface-700">
                Import backup
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void doImport(file);
                  e.target.value = '';
                }}
              />
            {dataResult && (
              <p role="status" className={dataResult.ok ? 'mt-2 text-xs text-green-600 dark:text-green-400' : 'mt-2 text-xs text-red-600 dark:text-red-400'}>
                {dataResult.msg}
              </p>
            )}
              <button onClick={() => void doWipe()} className="btn-danger">
                Delete all data
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
