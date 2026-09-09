import { useEffect, useRef, useState } from 'react';
import { fetchModels } from '../lib/api';
import { filterModels } from '../lib/models';
import { readProject } from '../lib/project';
import { useChats } from '../store/useChats';
import { useSettings } from '../store/useSettings';
import { IconSend, IconStop } from './Icons';
import type { AppMode } from '../types';

const MAX_HEIGHT = 200;

export default function Composer({ mode }: { mode: AppMode }) {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelSource, setModelSource] = useState('');
  const [modelError, setModelError] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [project, setProject] = useState<Awaited<ReturnType<typeof readProject>> | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const send = useChats((s) => s.send);
  const stop = useChats((s) => s.stop);
  const streaming = useChats((s) => s.streaming);
  const activeChatId = useChats((s) => s.activeChatId);
  const settings = useSettings((s) => s.settings);
  const updateProvider = useSettings((s) => s.updateProvider);
  const sendOnEnter = settings.sendOnEnter;
  const provider = settings.providers.find((p) => p.id === settings.activeProviderId) ?? null;
  const providerSource = provider ? `${provider.id}\0${provider.baseUrl}\0${provider.apiKey}` : '';
  const hasProvider = provider !== null;
  const webSupported = provider?.model.startsWith('openrouter/') ?? false;

  // Grow with content up to a cap, then scroll internally.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // Refocus when switching chats, but not on touch devices where it would
  // pop the on-screen keyboard open unprompted.
  useEffect(() => {
    if (window.matchMedia('(hover: hover)').matches) ref.current?.focus();
  }, [activeChatId]);

  useEffect(() => {
    if (!pickerOpen || !provider || modelSource === providerSource) return;
    const controller = new AbortController();
    setModelError('');
    void fetchModels(provider, controller.signal)
      .then((items) => {
        setModels(items.map((item) => item.id));
        setModelSource(providerSource);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setModelError(error instanceof Error ? error.message : 'Could not load models');
      });
    return () => controller.abort();
  }, [pickerOpen, provider, providerSource, modelSource]);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [pickerOpen]);

  const submit = () => {
    const value = text.trim();
    if (!value || streaming) return;
    setText('');
    void send(value, mode === 'chat' ? undefined : project?.context, mode);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    // IME composition must not be interrupted mid-word.
    if (e.nativeEvent.isComposing) return;

    const wantsSend = sendOnEnter ? !e.shiftKey : e.ctrlKey || e.metaKey;
    if (wantsSend) {
      e.preventDefault();
      submit();
    }
  };

  const chooseModel = async (model: string) => {
    if (!provider) return;
    await updateProvider(provider.id, { model });
    setPickerOpen(false);
    setQuery('');
    ref.current?.focus();
  };

  return (
    <div className="safe-bottom bg-gradient-to-t from-surface-0 via-surface-0 to-transparent
                    px-3 pb-3 pt-2 dark:from-surface-950 dark:via-surface-950 sm:px-4 sm:pb-4">
      <div className="mx-auto max-w-3xl">
        <div
          className="rounded-[26px] border border-surface-200 bg-surface-0 p-2 pl-4
                     shadow-sm transition-colors focus-within:border-surface-400
                     dark:border-surface-700 dark:bg-surface-900 dark:focus-within:border-surface-500"
        >
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5 px-1">
              {attachments.map((name) => (
                <span key={name} className="flex max-w-52 items-center gap-1 rounded-lg bg-surface-100 px-2 py-1 text-xs dark:bg-surface-800">
                  <span className="truncate">{name}</span>
                  <button type="button" onClick={() => setAttachments((items) => items.filter((item) => item !== name))} aria-label={`Remove ${name}`}>×</button>
                </span>
              ))}
            </div>
          )}
          {mode !== 'chat' && project && !project.hasOverview && (
            <p role="status" className="mb-2 rounded-lg bg-amber-50 px-2 py-1.5 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              No README or project manifest found. Choose the code repository root so the AI has enough evidence.
            </p>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={hasProvider ? (mode === 'chat' ? 'Send a message…' : mode === 'code' ? 'Describe what you want to build or fix…' : 'Describe the outcome you want…') : 'Add a provider in Settings to start'}
            disabled={!hasProvider}
            aria-label="Message input"
            className="scrollbar-thin max-h-[200px] w-full resize-none bg-transparent px-1 py-1.5
                       text-[16px] leading-6 outline-none placeholder:text-surface-400
                       disabled:cursor-not-allowed dark:placeholder:text-surface-600"
          />

          <div className="mt-1 flex items-end justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              {mode !== 'chat' && (
                <>
                  <input
                    ref={(element) => {
                      projectRef.current = element;
                      element?.setAttribute('webkitdirectory', '');
                    }}
                    type="file"
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length) void readProject(files).then(setProject);
                    }}
                  />
                  <button
                    type="button"
                    disabled={streaming}
                    onClick={() => projectRef.current?.click()}
                    className={`max-w-40 truncate rounded-full px-2.5 py-1.5 text-xs transition-colors ${
                      project
                        ? 'bg-accent/10 font-medium text-accent'
                        : 'text-surface-600 hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-800'
                    }`}
                    title={project ? `${project.fileCount} project files selected` : 'Choose a project folder'}
                  >
                    ▣ {project ? `${project.name} · ${project.fileCount}` : 'Add project'}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => setAttachments(Array.from(event.target.files ?? [], (file) => file.name))}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="rounded-full px-2 py-1 text-lg leading-none text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800"
                    title="Attach files (UI preview)"
                    aria-label="Attach files"
                  >
                    +
                  </button>
                </>
              )}
              <div ref={pickerRef} className="relative min-w-0">
                <button
                  type="button"
                  disabled={!provider || streaming}
                  onClick={() => setPickerOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                  className="flex max-w-[260px] items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium
                             text-surface-600 transition-colors hover:bg-surface-100 disabled:opacity-40
                             dark:text-surface-300 dark:hover:bg-surface-800"
                >
                  <span className="truncate">{provider?.model ?? 'Choose model'}</span>
                  <span aria-hidden>⌄</span>
                </button>

                {pickerOpen && provider && (
                  <div className="absolute bottom-full left-0 z-20 mb-2 w-[min(360px,calc(100vw-40px))] overflow-hidden
                                  rounded-2xl border border-surface-200 bg-white shadow-xl dark:border-surface-700 dark:bg-surface-800">
                  <div className="border-b border-surface-100 p-2 dark:border-surface-700">
                    <input
                      autoFocus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Escape') setPickerOpen(false); }}
                      placeholder="Search models…"
                      aria-label="Search models"
                      className="input"
                    />
                  </div>
                  <div role="listbox" aria-label="Models" className="scrollbar-thin max-h-72 overflow-y-auto p-1.5">
                    {filterModels(models, query).map((model) => (
                      <button
                        key={model}
                        type="button"
                        role="option"
                        aria-selected={provider.model === model}
                        onClick={() => void chooseModel(model)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm
                                   hover:bg-surface-100 dark:hover:bg-surface-700"
                      >
                        <span className="truncate">{model}</span>
                        {provider.model === model && <span className="text-accent">✓</span>}
                      </button>
                    ))}
                    {!models.length && !modelError && <p className="px-3 py-5 text-center text-sm text-surface-400">Loading models…</p>}
                    {modelError && <p role="alert" className="px-3 py-3 text-sm text-red-500">{modelError}</p>}
                  </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                disabled={!webSupported || streaming}
                onClick={() => void useSettings.getState().update({ webSearch: !settings.webSearch })}
                aria-pressed={settings.webSearch && webSupported}
                title={webSupported ? 'Toggle web search' : 'Choose an openrouter/ model to use web search'}
                className={`rounded-full px-2.5 py-1.5 text-xs transition-colors disabled:opacity-30 ${
                  settings.webSearch && webSupported
                    ? 'bg-accent text-white'
                    : 'text-surface-600 hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-800'
                }`}
              >
                🌐 Web
              </button>

              {settings.webSearch && webSupported && (
                <select
                  aria-label="Web search engine"
                  value={settings.webSearchEngine}
                  disabled={streaming}
                  onChange={(event) => void useSettings.getState().update({ webSearchEngine: event.target.value as typeof settings.webSearchEngine })}
                  className="rounded-full border border-surface-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-surface-700"
                >
                  <option value="auto">Auto</option>
                  <option value="exa">Exa</option>
                  <option value="parallel">Parallel</option>
                  <option value="perplexity">Perplexity</option>
                </select>
              )}

              {mode !== 'chat' && (
                <select
                  aria-label="Action approval mode"
                  className="max-w-36 rounded-full border border-surface-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-surface-700"
                  defaultValue="ask"
                >
                  <option value="ask">Ask before actions</option>
                  <option value="plan">Plan only</option>
                  <option value="allow">Allow safe actions</option>
                </select>
              )}
            </div>

            {streaming ? (
              <button onClick={stop} className="shrink-0 rounded-full bg-surface-900 p-2 text-white
                                           transition-opacity hover:opacity-80 dark:bg-surface-100
                                           dark:text-surface-900" title="Stop generating" aria-label="Stop generating">
                <IconStop className="h-5 w-5" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!text.trim() || !hasProvider}
                className="shrink-0 rounded-full bg-surface-900 p-2 text-white transition-opacity
                           hover:opacity-80 disabled:opacity-30 dark:bg-surface-100 dark:text-surface-900"
                title="Send"
                aria-label="Send message"
              >
                <IconSend className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        <p className="mt-2 hidden text-center text-xs text-surface-700/50 dark:text-surface-200/40 sm:block">
          {sendOnEnter ? 'Enter to send · Shift+Enter for newline' : 'Ctrl+Enter to send'}
        </p>
      </div>
    </div>
  );
}
