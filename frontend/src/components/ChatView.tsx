import { useEffect, useRef } from 'react';
import { useChats } from '../store/useChats';
import MessageBubble from './MessageBubble';
import { IconLock, IconRefresh } from './Icons';
import type { AppMode } from '../types';

const taskStarters = [
  ['Research brief', 'Research this topic and turn the findings into a concise, source-backed brief.'],
  ['Draft a deliverable', 'Help me turn my rough notes into a polished document with clear next steps.'],
  ['Compare options', 'Compare my options, explain the trade-offs, and recommend the best one.'],
  ['Plan a project', 'Break this project into a practical plan with milestones, risks, and next actions.'],
] as const;

export default function ChatView({ mode }: { mode: AppMode }) {
  const messages = useChats((s) => s.messages);
  const streaming = useChats((s) => s.streaming);
  const streamingId = useChats((s) => s.streamingId);
  const regenerate = useChats((s) => s.regenerate);
  const activeChatId = useChats((s) => s.activeChatId);
  const send = useChats((s) => s.send);

  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Only auto-scroll while the user is already at the bottom, so scrolling up
  // to read history is not fought by incoming tokens.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => {
    pinned.current = true;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [activeChatId]);

  const canRegenerate =
    !streaming && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

  if (messages.length === 0) {
    if (mode === 'cowork') {
      return (
        <div className="scrollbar-thin flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
          <div className="w-full max-w-2xl">
            <p className="mb-2 text-center text-sm font-medium text-accent">TAWX Desktop</p>
            <h1 className="text-center text-3xl font-semibold tracking-tight text-surface-800 dark:text-surface-100">
              What do you want to get done?
            </h1>
            <p className="mx-auto mt-3 max-w-lg text-center text-sm leading-6 text-surface-500">
              Describe the outcome. TAWX will help shape the work and produce a useful deliverable.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {taskStarters.map(([title, prompt]) => (
                <button
                  key={title}
                  type="button"
                  onClick={() => void send(prompt)}
                  className="rounded-2xl border border-surface-200 bg-surface-50 p-4 text-left transition-colors
                             hover:border-surface-300 hover:bg-surface-100 dark:border-surface-800
                             dark:bg-surface-900 dark:hover:border-surface-700 dark:hover:bg-surface-800"
                >
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="mt-1.5 block text-xs leading-5 text-surface-500">{prompt}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 grid grid-cols-4 overflow-hidden rounded-xl border border-surface-200 text-center text-[11px] text-surface-500 dark:border-surface-800">
              {['Plan', 'Use tools', 'Ask approval', 'Deliver'].map((step, index) => (
                <div key={step} className="border-r border-surface-200 px-2 py-2.5 last:border-r-0 dark:border-surface-800">
                  <span className="mr-1 text-accent">{index + 1}</span>{step}
                </div>
              ))}
            </div>
            <p className="mt-6 flex items-center justify-center gap-2 text-xs text-surface-400">
              <IconLock className="h-3.5 w-3.5" /> Actions will require your approval when tools are connected
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="mb-3 text-2xl font-semibold text-surface-800 dark:text-surface-100">What can I help with?</h1>
          <p className="mb-6 text-sm text-surface-500 dark:text-surface-400">
            A ChatGPT-style interface for any OpenAI-compatible API.
          </p>
          <p className="inline-flex items-center gap-2 rounded-full bg-surface-100 px-3 py-1.5 text-xs text-surface-500 dark:bg-surface-800 dark:text-surface-400">
            <IconLock className="h-3.5 w-3.5" />
            Chats never leave your browser
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin flex-1 overflow-y-auto">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} isStreaming={streaming && m.id === streamingId} />
      ))}

      {canRegenerate && (
        <div className="flex justify-center py-4">
          <button
            onClick={() => void regenerate()}
            className="btn-ghost border border-surface-200 dark:border-surface-700"
          >
            <IconRefresh className="h-4 w-4" />
            Regenerate
          </button>
        </div>
      )}

      <div ref={endRef} className="h-4" />
    </div>
  );
}
