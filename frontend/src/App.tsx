import { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import Composer from './components/Composer';
import SettingsModal from './components/SettingsModal';
import CoworkHub from './components/CoworkHub';
import { useChats } from './store/useChats';
import { useSettings } from './store/useSettings';
import { applyTheme } from './store/useSettings';
import { IconMenu, IconSettings } from './components/Icons';
import type { AppMode, CoworkSection } from './types';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<AppMode>('chat');
  const [coworkSection, setCoworkSection] = useState<CoworkSection>('tasks');

  const hydrateSettings = useSettings((s) => s.hydrate);
  const settingsLoaded = useSettings((s) => s.loaded);
  const theme = useSettings((s) => s.settings.theme);
  const hasProvider = useSettings((s) => s.settings.activeProviderId !== null);

  const hydrateChats = useChats((s) => s.hydrate);
  const error = useChats((s) => s.error);
  const clearError = useChats((s) => s.clearError);
  const activeChatId = useChats((s) => s.activeChatId);
  const chats = useChats((s) => s.chats);

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

  const title = chats.find((c) => c.id === activeChatId)?.title ?? 'New chat';

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        mode={mode}
        activeSection={coworkSection}
        onSelectSection={setCoworkSection}
        onClose={() => setSidebarOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
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
            onClick={() => setSettingsOpen(true)}
            className="btn-ghost !px-2"
            aria-label="Open settings"
          >
            <IconSettings />
          </button>
        </header>

        <header className="flex h-12 shrink-0 items-center justify-center border-b border-surface-200 dark:border-surface-800 md:h-14">
          <div className="flex rounded-xl bg-surface-100 p-1 dark:bg-surface-900" role="tablist" aria-label="Workspace mode">
            {(['chat', 'cowork'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => {
                  setMode(item);
                  if (item === 'cowork') setCoworkSection('tasks');
                }}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                  mode === item
                    ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-white'
                    : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'
                }`}
              >
                {item}
              </button>
            ))}
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
    </div>
  );
}
