import { useEffect, useMemo, useRef, useState } from 'react';
import { useChats } from '../store/useChats';
import { chatMode, type AppMode, type Chat, type CoworkSection, type TaskStatus } from '../types';
import { cn, groupByDate } from '../lib/utils';
import { IconChat, IconClose, IconEdit, IconLock, IconPlus, IconSettings, IconTrash } from './Icons';
import FocusSoundMenu from './FocusSoundMenu';

const taskStatusLabels: Record<TaskStatus, string> = {
  planning: 'Planning',
  running: 'Running',
  waiting_approval: 'Approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const taskStatusStyles: Record<TaskStatus, string> = {
  planning: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  running: 'bg-accent/10 text-accent',
  waiting_approval: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  completed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-red-500/10 text-red-700 dark:text-red-300',
  cancelled: 'bg-surface-200 text-surface-500 dark:bg-surface-700 dark:text-surface-300',
};

interface Props {
  open: boolean;
  mode: AppMode;
  collapsed: boolean;
  searchRequest: number;
  activeSection: CoworkSection;
  onSelectSection: (section: CoworkSection) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}

export default function Sidebar({
  open,
  collapsed,
  searchRequest,
  mode,
  activeSection,
  onSelectSection,
  onClose,
  onOpenSettings,
  onOpenShortcuts,
}: Props) {
  const chats = useChats((s) => s.chats);
  const activeChatId = useChats((s) => s.activeChatId);
  const runningChatIds = useChats((s) => s.runningChatIds);
  const selectChat = useChats((s) => s.selectChat);
  const newChat = useChats((s) => s.newChat);
  const removeChat = useChats((s) => s.removeChat);
  const renameChat = useChats((s) => s.renameChat);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const map = new Map<string, Chat[]>();
    for (const chat of chats.filter((chat) => (
      chatMode(chat) === mode && chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    ))) {
      const key = groupByDate(chat.updatedAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(chat);
      else map.set(key, [chat]);
    }
    return [...map.entries()];
  }, [chats, mode, query]);

  const visibleChats = groups.flatMap(([, items]) => items);

  useEffect(() => {
    if (searchRequest > 0) searchRef.current?.focus();
  }, [searchRequest]);
  useEffect(() => setQuery(''), [mode]);

  const commitRename = async (id: string) => {
    const title = draft.trim();
    if (title) await renameChat(id, title);
    setEditingId(null);
  };

  const handleSelect = async (id: string) => {
    await selectChat(id);
    onClose();
  };

  return (
    <>
      {/* Scrim: mobile only, closes the drawer on tap. */}
      <div
        onClick={onClose}
        aria-hidden
        className={cn(
          'fixed inset-0 z-30 bg-black/50 transition-opacity md:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col bg-surface-50 text-surface-700',
          'border-r border-surface-200 transition-transform duration-200 dark:bg-surface-900 dark:border-surface-800 dark:text-surface-300',
          'md:z-auto',
          collapsed ? 'md:fixed md:-translate-x-full' : 'md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="safe-top flex items-center gap-2 p-3">
          <button
            onClick={() => {
              newChat(mode);
              if (mode === 'cowork') onSelectSection('tasks');
              onClose();
            }}
            className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2.5
                       text-sm font-medium transition-colors hover:bg-surface-100
                       dark:hover:bg-surface-800"
            title="New chat (⌘N)"
          >
            <IconPlus className="h-4 w-4" />
            New {mode === 'chat' ? 'chat' : mode === 'code' ? 'code task' : 'task'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-2.5 transition-colors hover:bg-surface-100 dark:hover:bg-surface-800 md:hidden"
            aria-label="Close sidebar"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="px-3 pb-3">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${mode === 'chat' ? 'chats' : 'tasks'}…`}
            aria-label={`Search ${mode === 'chat' ? 'chats' : 'tasks'}`}
            title="Search chats (⌘K)"
            className="input !py-2 text-sm"
          />
        </div>

        {mode !== 'chat' && (
          <div className="px-5 pb-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-surface-400">{mode === 'code' ? 'Code' : 'Cowork'}</p>
            <p className="mt-0.5 text-xs text-surface-500">
              {mode === 'code' ? 'Workspace changes, checks, and diffs' : 'Delegated tasks and execution history'}
            </p>
          </div>
        )}

        {mode === 'cowork' && (
          <div className="space-y-1 border-b border-surface-200 px-2 pb-3 dark:border-surface-800">
            {([
              ['tasks', '✦', 'Tasks'],
              ['schedules', '◷', 'Schedules'],
              ['tools', '⌘', 'Tools'],
              ['skills', '◇', 'Skills'],
            ] as const).map(([section, icon, label]) => (
              <button
                key={section}
                type="button"
                onClick={() => {
                  onSelectSection(section);
                  onClose();
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                  activeSection === section
                    ? 'bg-surface-100 font-medium text-surface-900 dark:bg-surface-800 dark:text-white'
                    : 'hover:bg-surface-100 dark:hover:bg-surface-800/60',
                )}
              >
                <span className="w-4 text-center text-surface-400" aria-hidden>{icon}</span>
                {label}
              </button>
            ))}
          </div>
        )}

        <nav className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-2 pb-2">
          {visibleChats.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-surface-400 dark:text-surface-600">
              {query.trim()
                ? `No matching ${mode === 'chat' ? 'chats' : 'tasks'}.`
                : `No ${mode === 'cowork' ? 'tasks' : mode === 'code' ? 'code tasks' : 'chats'} yet.`}
              {!query.trim() && (
                <>
                  <br />
                  {mode === 'chat' ? 'Start a conversation.' : mode === 'code' ? 'Describe a code change.' : 'Describe an outcome.'}
                </>
              )}
            </p>
          )}

          {groups.map(([label, items]) => (
            <section key={label}>
              <h2 className="px-3 pb-1.5 pt-2 text-xs font-medium uppercase tracking-wide text-surface-400 dark:text-surface-600">
                {label}
              </h2>
              <ul className="space-y-0.5">
                {items.map((chat) => (
                  <li key={chat.id}>
                    {editingId === chat.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => void commitRename(chat.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(chat.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        aria-label={`Rename ${mode === 'chat' ? 'chat' : 'task'}`}
                        className="w-full rounded-lg bg-surface-100 px-3 py-2 text-sm outline-none
                                   ring-1 ring-surface-400 dark:bg-surface-800"
                      />
                    ) : (
                      <div
                        className={cn(
                          'group flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                          activeChatId === chat.id ? 'bg-surface-100 dark:bg-surface-800' : 'hover:bg-surface-100 dark:hover:bg-surface-800/60',
                        )}
                      >
                        <button
                          onClick={() => void handleSelect(chat.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          {mode === 'chat' ? (
                            <IconChat className="h-4 w-4 shrink-0 opacity-50" />
                          ) : (
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-xs font-semibold text-surface-400" aria-hidden>
                              {mode === 'code' ? '</>' : '✦'}
                            </span>
                          )}
                          <span className="truncate">{chat.title}</span>
                        </button>

                        {runningChatIds.includes(chat.id) && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
                            aria-label="Still answering"
                            title="Still answering"
                          />
                        )}

                        {mode !== 'chat' && chat.taskStatus && (
                          <span
                            className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium', taskStatusStyles[chat.taskStatus])}
                            aria-label={`Task status: ${taskStatusLabels[chat.taskStatus]}`}
                          >
                            {taskStatusLabels[chat.taskStatus]}
                          </span>
                        )}
                        <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <button
                            onClick={() => {
                              setEditingId(chat.id);
                              setDraft(chat.title);
                            }}
                            className="rounded p-1 hover:bg-surface-200 dark:hover:bg-surface-700"
                            title="Rename"
                            aria-label="Rename chat"
                          >
                            <IconEdit className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => void removeChat(chat.id)}
                            className="rounded p-1 hover:bg-surface-200 hover:text-red-500 dark:hover:bg-surface-700"
                            title="Delete"
                            aria-label="Delete chat"
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>

        <div className="safe-bottom border-t border-surface-200 p-2 dark:border-surface-800">
          <FocusSoundMenu />
          <button
            type="button"
            onClick={() => {
              onOpenShortcuts();
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-surface-100 dark:hover:bg-surface-800"
            title="Keyboard shortcuts"
          >
            <span className="w-4 text-center" aria-hidden>⌘</span>
            Keyboard shortcuts
          </button>
          <button
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm
                       transition-colors hover:bg-surface-100 dark:hover:bg-surface-800"
            title="Settings (⌘,)"
          >
            <IconSettings className="h-4 w-4" />
            Settings
          </button>
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-surface-400 dark:text-surface-600">
            <IconLock className="h-3 w-3" />
            Stored locally in your browser
          </p>
        </div>
      </aside>
    </>
  );
}
