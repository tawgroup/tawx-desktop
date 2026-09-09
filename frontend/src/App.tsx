import { useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import Composer from './components/Composer';
import SettingsModal from './components/SettingsModal';
import SystemPromptEditor from './components/SystemPromptEditor';
import ContextInspector, {
  type ContextInspection,
  type InspectedContextItem,
} from './components/ContextInspector';
import CoworkHub from './components/CoworkHub';
import { selectContextPreview, useChats } from './store/useChats';
import { useSettings } from './store/useSettings';
import { applyTheme } from './store/useSettings';
import { completionBody } from './lib/api';
import { IconEdit, IconMenu, IconSettings } from './components/Icons';
import { chatMode, type AppMode, type CoworkSection } from './types';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [contextInspectorOpen, setContextInspectorOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>('chat');
  const [coworkSection, setCoworkSection] = useState<CoworkSection>('tasks');

  const hydrateSettings = useSettings((s) => s.hydrate);
  const settingsLoaded = useSettings((s) => s.loaded);
  const settings = useSettings((s) => s.settings);
  const theme = settings.theme;
  const hasProvider = settings.activeProviderId !== null;

  const hydrateChats = useChats((s) => s.hydrate);
  const error = useChats((s) => s.error);
  const clearError = useChats((s) => s.clearError);
  const chats = useChats((s) => s.chats);
  const selectChat = useChats((s) => s.selectChat);
  const newChat = useChats((s) => s.newChat);
  const activeChat = useChats((s) => s.activeChat);
  const draftThread = useChats((s) => s.draftThread);
  const messages = useChats((s) => s.messages);
  const activeTask = useChats((s) => s.activeTask);
  const contextPreview = useChats(selectContextPreview);
  const setThreadSystemPrompt = useChats((s) => s.setThreadSystemPrompt);

  useEffect(() => {
    void hydrateSettings();
    void hydrateChats();
  }, [hydrateSettings, hydrateChats]);

  // Prompt for configuration on a first visit, once state is known.
  useEffect(() => {
    if (settingsLoaded && !hasProvider) setSettingsOpen(true);
  }, [settingsLoaded, hasProvider]);

  // Follow the OS theme live while set to "system".
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const activeThread = activeChat && chatMode(activeChat) === mode ? activeChat : null;
  const title = activeThread?.title ?? 'New chat';
  const threadPrompt = activeThread
    ? activeThread.systemPrompt ?? settings.systemPrompt
    : draftThread.systemPrompt;
  const promptActive = contextPreview.systemPrompt.trim().length > 0;
  const skillsConfigured = mode !== 'chat' && contextPreview.enabledSkillIds.length > 0;
  const promptControlActive = promptActive || skillsConfigured;
  const promptControlLabel = promptActive ? 'Prompt active' : skillsConfigured ? 'Skills active' : 'No prompt';
  const legacyDefault = Boolean(
    activeThread && chats.find((chat) => chat.id === activeThread.id)?.systemPrompt === undefined,
  );
  const systemPromptSource: ContextInspection['systemPromptSource'] = !contextPreview.systemPrompt.trim()
    ? 'none'
    : activeThread
      ? legacyDefault ? 'legacy default' : 'thread snapshot'
      : draftThread.systemPrompt === settings.systemPrompt ? 'new-thread default' : 'new-thread draft';

  const includedItems = useMemo<InspectedContextItem[]>(() => {
    const items: InspectedContextItem[] = contextPreview.attachments.map((attachment) => ({
      id: `attachment-${attachment.id}`,
      name: attachment.name,
      kind: attachment.kind === 'image' ? 'image' : 'file',
      mediaType: attachment.mimeType,
      size: attachment.size,
      text: attachment.text,
      imageUrl: attachment.dataUrl,
      source: attachment.truncated ? 'attachment · truncated' : 'attachment',
    }));
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.context) continue;
      items.push({
        id: `project-${message.id}`,
        name: 'Local project snapshot',
        kind: 'project',
        text: message.context,
        source: `${message.role} turn`,
      });
      break;
    }
    return items;
  }, [contextPreview.attachments, messages]);

  const activeProvider = settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? null;
  const request = useMemo<Record<string, unknown>>(() => {
    if (mode === 'chat') {
      return completionBody({
        model: activeProvider?.model ?? '',
        messages: contextPreview.messages,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        webSearch: settings.webSearch && activeProvider?.model.startsWith('openrouter/')
          ? settings.webSearchEngine
          : undefined,
      }, settings.streaming);
    }
    return {
      threadId: activeThread?.id ?? '<generated when sent>',
      mode,
      messages: contextPreview.messages,
      systemPrompt: contextPreview.systemPrompt,
      ...(contextPreview.workspace ? { workspace: contextPreview.workspace } : {}),
      policy: contextPreview.policy,
      enabledTools: contextPreview.enabledTools,
      enabledSkillIds: contextPreview.enabledSkillIds,
    };
  }, [activeProvider?.model, activeThread?.id, contextPreview, mode, settings]);

  const inspection = useMemo<ContextInspection>(() => ({
    threadId: activeThread?.id ?? null,
    threadTitle: title,
    systemPrompt: contextPreview.systemPrompt,
    mode,
    systemPromptSource,
    workspace: contextPreview.workspace ?? null,
    includedItems,
    enabledTools: contextPreview.enabledTools,
    enabledSkills: contextPreview.enabledSkillIds,
    policy: contextPreview.policy,
    tokenUsage: {
      used: contextPreview.budget.usedTokens,
      budget: contextPreview.budget.maxTokens,
      remaining: contextPreview.budget.remainingTokens,
      compactedMessages: contextPreview.budget.compactedMessages,
      compactionCount: contextPreview.budget.compactionCount,
      measuredAt: contextPreview.budget.updatedAt,
      lastCompactedAt: contextPreview.budget.lastCompactedAt,
      summary: contextPreview.budget.summary,
    },
    request,
    requestStage: mode === 'chat' ? 'chat' : 'desktop-task',
    taskStatus: activeTask?.status,
  }), [activeTask?.status, activeThread?.id, contextPreview, includedItems, mode, request, systemPromptSource, title]);

  const openSettings = () => {
    setPromptEditorOpen(false);
    setContextInspectorOpen(false);
    setSettingsOpen(true);
  };
  const openPromptEditor = () => {
    setSettingsOpen(false);
    setContextInspectorOpen(false);
    setPromptEditorOpen(true);
  };
  const openContextInspector = () => {
    setSettingsOpen(false);
    setPromptEditorOpen(false);
    setContextInspectorOpen(true);
  };
  const changeMode = (nextMode: AppMode) => {
    setMode(nextMode);
    if (nextMode === 'cowork') setCoworkSection('tasks');
    const nextChat = chats.find((chat) => chatMode(chat) === nextMode);
    if (nextChat) {
      void selectChat(nextChat.id);
    } else {
      newChat(nextMode);
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        mode={mode}
        activeSection={coworkSection}
        onSelectSection={setCoworkSection}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={openSettings}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="safe-top flex shrink-0 items-center gap-2 border-b border-surface-200 px-3 py-2.5 dark:border-surface-800 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="btn-ghost !px-2"
            aria-label="Open sidebar"
          >
            <IconMenu />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-center text-sm font-medium">{title}</h1>
          <button
            onClick={openSettings}
            className="btn-ghost !px-2"
            aria-label="Open settings"
          >
            <IconSettings />
          </button>
        </header>

        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-surface-200 px-2 dark:border-surface-800 md:h-14 md:px-3">
          <div className="flex min-w-9 flex-1 justify-start">
            <button
              type="button"
              onClick={openPromptEditor}
              className={`btn-ghost min-w-9 !px-2 ${promptControlActive ? '!text-accent' : ''}`}
              aria-label={`${promptControlLabel}. Edit thread system prompt`}
              title={promptActive ? 'System prompt active' : skillsConfigured ? 'Selected skill instructions active' : 'No system prompt'}
            >
              <span className={`h-2 w-2 rounded-full ${promptControlActive ? 'bg-accent' : 'bg-surface-300 dark:bg-surface-600'}`} />
              <IconEdit className="h-4 w-4" />
              <span className="hidden sm:inline">{promptControlLabel}</span>
            </button>
          </div>
          <div className="flex shrink-0 rounded-xl bg-surface-100 p-1 dark:bg-surface-900" role="tablist" aria-label="Workspace mode">
            {(['chat', 'cowork', 'code'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => changeMode(item)}
                className={`rounded-lg px-2.5 py-1.5 text-sm font-medium capitalize transition-colors sm:px-4 ${
                  mode === item
                    ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-white'
                    : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="flex min-w-9 flex-1 justify-end">
            <button
              type="button"
              onClick={openContextInspector}
              className="btn-ghost !px-2 text-xs sm:!px-3 sm:text-sm"
              aria-label="Inspect model context"
            >
              Context
            </button>
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-2.5 text-sm
                       text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
          >
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={clearError} className="shrink-0 font-medium underline">
              Dismiss
            </button>
          </div>
        )}

        {mode === 'cowork' && coworkSection !== 'tasks' ? (
          <CoworkHub section={coworkSection} />
        ) : (
          <>
            <ChatView mode={mode} />
            <Composer mode={mode} />
          </>
        )}
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SystemPromptEditor
        open={promptEditorOpen}
        onClose={() => setPromptEditorOpen(false)}
        prompt={threadPrompt}
        threadTitle={title}
        mode={mode}
        scope={activeThread ? 'thread' : 'new'}
        enabledSkillCount={contextPreview.enabledSkillIds.length}
        inheritedDefault={legacyDefault}
        onSave={setThreadSystemPrompt}
      />
      <ContextInspector
        open={contextInspectorOpen}
        onClose={() => setContextInspectorOpen(false)}
        inspection={inspection}
      />
    </div>
  );
}
