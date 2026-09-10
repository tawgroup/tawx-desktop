import { useEffect, useRef, useState } from 'react';
import { fetchModels } from '../lib/api';
import { ATTACHMENT_ACCEPT, prepareAttachments } from '../lib/attachments';
import { isProviderRoutable, modelRoutes, visionModelIds } from '../lib/providers.ts';
import { configuredVisionRoute, needsVisionFallback } from '../lib/vision.ts';
import { useChats } from '../store/useChats';
import { useSettings } from '../store/useSettings';
import type { AppMode, ThreadPolicy } from '../types';
import AttachmentTray from './AttachmentTray';
import { IconSend, IconStop } from './Icons';

const MAX_HEIGHT = 200;
interface Props {
  mode: AppMode;
  onOpenSettings: () => void;
}


export default function Composer({ mode, onOpenSettings }: Props) {
  const [text, setText] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [modelSource, setModelSource] = useState('');
  const [modelError, setModelError] = useState('');
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const attachmentOperationRef = useRef(0);
  const preparingAttachmentsRef = useRef(false);

  const send = useChats((s) => s.send);
  const stop = useChats((s) => s.stop);
  const streaming = useChats((s) => s.streaming);
  const visionProgress = useChats((s) => s.visionProgress);
  const activeChatId = useChats((s) => s.activeChatId);
  const attachments = useChats((s) => s.attachments);
  const addAttachments = useChats((s) => s.addAttachments);
  const removeAttachment = useChats((s) => s.removeAttachment);
  const workspace = useChats((s) => s.workspace);
  const selectWorkspace = useChats((s) => s.selectWorkspace);
  const policy = useChats((s) => s.policy);
  const setThreadPolicy = useChats((s) => s.setThreadPolicy);
  const settings = useSettings((s) => s.settings);
  const updateProvider = useSettings((s) => s.updateProvider);
  const setActiveProvider = useSettings((s) => s.setActiveProvider);
  const refreshProvider = useSettings((s) => s.refreshProvider);
  const sendOnEnter = settings.sendOnEnter;
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId && isProviderRoutable(item))
    ?? settings.providers.find(isProviderRoutable)
    ?? null;
  // `hasApiKey` stands in for the key of a managed provider, whose `apiKey` is
  // always empty here — without it, replacing a key would not refresh the list.
  const providerSource = provider
    ? `${provider.id}\0${provider.baseUrl}\0${provider.apiKey}\0${provider.hasApiKey ?? ''}`
    : '';
  const routes = modelRoutes(settings.providers);
  const filteredRoutes = routes.filter((route) => {
    const needle = query.trim().toLowerCase();
    return !needle || `${route.providerName} ${route.model}`.toLowerCase().includes(needle);
  });
  const hasProvider = provider !== null;
  const canCompose = mode !== 'chat' || hasProvider;
  const webSupported = provider?.kind === 'openrouter' || (provider?.model.startsWith('openrouter/') ?? false);
  const hasPendingImages = attachments.some((attachment) => attachment.kind === 'image');
  const visionFallbackNeeded = hasPendingImages && needsVisionFallback(mode, settings, provider);
  const visionRoute = configuredVisionRoute(settings);

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
    attachmentOperationRef.current += 1;
    preparingAttachmentsRef.current = false;
    setPreparingAttachments(false);
    setAttachmentErrors([]);
    if (window.matchMedia('(hover: hover)').matches) ref.current?.focus();
  }, [activeChatId, mode]);

  useEffect(() => () => {
    attachmentOperationRef.current += 1;
    preparingAttachmentsRef.current = false;
  }, []);

  useEffect(() => {
    if (!pickerOpen || !provider || modelSource === providerSource) return;
    const controller = new AbortController();
    setModelError('');

    // A managed provider's key never reaches this renderer, so the probe has to
    // run in the main process; calling the vendor from here would go out
    // unauthenticated.
    const load = provider.ownership === 'managed'
      ? refreshProvider(provider.id).then(() => setModelSource(providerSource))
      : fetchModels(provider, controller.signal).then(async (items) => {
          setModelSource(providerSource);
          await updateProvider(provider.id, {
            discoveredModels: items.map((item) => item.id),
            visionModels: visionModelIds(items),
            connectionStatus: 'connected',
            lastCheckedAt: Date.now(),
            lastError: undefined,
          });
        });

    void load.catch((error: unknown) => {
      if (!controller.signal.aborted) setModelError(error instanceof Error ? error.message : 'Could not load models');
    });
  }, [pickerOpen, provider, providerSource, modelSource, updateProvider, refreshProvider]);

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
    if ((!value && !attachments.length) || streaming || preparingAttachments) return;
    setAttachmentErrors([]);
    const submitted = text;
    const accepted = send(value, mode);
    if (visionFallbackNeeded && !visionRoute) onOpenSettings();
    void accepted.then((sent) => {
      if (sent) setText((current) => (current === submitted ? '' : current));
    });
  };

  const addFiles = async (files: readonly File[]) => {
    if (!files.length || preparingAttachmentsRef.current) return;
    preparingAttachmentsRef.current = true;
    const operation = ++attachmentOperationRef.current;
    const sourceChatId = useChats.getState().activeChatId;
    setPreparingAttachments(true);
    setAttachmentErrors([]);
    try {
      const prepared = await prepareAttachments(files, useChats.getState().attachments);
      if (operation !== attachmentOperationRef.current || sourceChatId !== useChats.getState().activeChatId) return;
      if (prepared.attachments.length) addAttachments(prepared.attachments);
      setAttachmentErrors(prepared.errors);
    } finally {
      if (operation === attachmentOperationRef.current) {
        preparingAttachmentsRef.current = false;
        setPreparingAttachments(false);
      }
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const itemFiles = Array.from(event.clipboardData.items).flatMap((item) => {
      const file = item.kind === 'file' ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
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

  const chooseModel = async (providerId: string, model: string) => {
    await setActiveProvider(providerId);
    await updateProvider(providerId, { model });
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
            <div className="mb-2 px-1">
              <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
            </div>
          )}
          {preparingAttachments && (
            <p role="status" aria-live="polite" className="mb-2 px-1 text-xs text-surface-500 dark:text-surface-400">
              Reading attachments…
            </p>
          )}
          {attachmentErrors.length > 0 && (
            <div id="attachment-errors" role="alert" aria-live="assertive" className="mb-2 rounded-lg bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
              <p className="font-medium">Some files could not be attached:</p>
              <ul className="mt-1 list-disc pl-4">
                {attachmentErrors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}
              </ul>
            </div>
          )}
          {visionFallbackNeeded && (
            <button
              type="button"
              onClick={onOpenSettings}
              className={`mb-2 rounded-full px-2.5 py-1 text-xs ${
                visionRoute
                  ? 'bg-accent/10 font-medium text-accent'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              }`}
              title={visionRoute
                ? `Images will be analyzed by ${visionRoute.provider.name} before the destination model receives text.`
                : 'Configure a Vision fallback before sending images to this model.'}
            >
              {visionRoute
                ? `Images via ${visionRoute.provider.name} · ${settings.visionModel}`
                : 'Configure Vision fallback'}
            </button>
          )}
          {visionProgress && (
            <p role="status" aria-live="polite" className="mb-2 px-1 text-xs font-medium text-accent">
              Analyzing images with {visionProgress.providerName} · {visionProgress.model}
              {' '}({visionProgress.completed}/{visionProgress.total})…
            </p>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={!canCompose ? 'Add a provider in Settings to start' : mode === 'chat' ? 'Send a message…' : mode === 'code' ? 'Describe what you want to build or fix…' : 'Describe the outcome you want…'}
            disabled={!canCompose}
            aria-label="Message input"
            className="scrollbar-thin max-h-[200px] w-full resize-none bg-transparent px-1 py-1.5
                       text-[16px] leading-6 outline-none placeholder:text-surface-400
                       disabled:cursor-not-allowed dark:placeholder:text-surface-600"
          />

          <div className="mt-1 flex items-end justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              {mode !== 'chat' && (
                <button
                  type="button"
                  disabled={streaming}
                  onClick={() => void selectWorkspace()}
                  className={`max-w-40 truncate rounded-full px-2.5 py-1.5 text-xs transition-colors ${
                    workspace
                      ? 'bg-accent/10 font-medium text-accent'
                      : 'text-surface-600 hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-800'
                  }`}
                  title={workspace?.path ?? 'Choose a workspace folder'}
                >
                  ▣ {workspace?.name ?? 'Add workspace'}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  void addFiles(files);
                }}
              />
              <button
                type="button"
                disabled={!canCompose || streaming || preparingAttachments}
                onClick={() => fileRef.current?.click()}
                className="rounded-full px-2 py-1 text-lg leading-none text-surface-500 hover:bg-surface-100 disabled:opacity-40 dark:hover:bg-surface-800"
                title="Attach images or readable files"
                aria-label="Attach images or readable files"
                aria-describedby={attachmentErrors.length ? 'attachment-errors' : undefined}
              >
                +
              </button>
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
                  <span className="truncate">{provider ? `${provider.name} · ${provider.model}` : 'Choose model'}</span>
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
                    {filteredRoutes.map((route) => {
                      const selected = provider.id === route.providerId && provider.model === route.model;
                      return (
                        <button
                          key={route.key}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => void chooseModel(route.providerId, route.model)}
                          className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-700"
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{route.model}</span>
                            <span className="block truncate text-[11px] text-surface-500">via {route.providerName}</span>
                          </span>
                          {selected && <span className="text-accent">✓</span>}
                        </button>
                      );
                    })}
                    {!filteredRoutes.length && !modelError && <p className="px-3 py-5 text-center text-sm text-surface-400">No matching models.</p>}
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
                  value={policy}
                  disabled={streaming}
                  onChange={(event) => void setThreadPolicy(event.target.value as ThreadPolicy)}
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
                                           dark:text-surface-900" title={visionProgress ? 'Stop image analysis' : 'Stop generating'} aria-label={visionProgress ? 'Stop image analysis' : 'Stop generating'}>
                <IconStop className="h-5 w-5" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={(!text.trim() && !attachments.length) || !canCompose || preparingAttachments}
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
