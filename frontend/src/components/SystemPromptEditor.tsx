import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IconClose } from './Icons';
import type { AppMode } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  prompt: string;
  threadTitle: string;
  mode: AppMode;
  enabledSkillCount: number;
  scope: 'new' | 'thread';
  inheritedDefault?: boolean;
  onSave: (prompt: string) => Promise<void>;
}

export default function SystemPromptEditor({
  open,
  onClose,
  prompt,
  threadTitle,
  mode,
  enabledSkillCount,
  scope,
  inheritedDefault = false,
  onSave,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, saving]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (textareaRef.current) {
      textareaRef.current.value = prompt;
      textareaRef.current.focus();
    }
  }, [open, prompt]);

  if (!open) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPrompt = String(new FormData(event.currentTarget).get('systemPrompt') ?? '');
    setSaving(true);
    setError(null);
    try {
      await onSave(nextPrompt);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the system prompt.');
    } finally {
      setSaving(false);
    }
  };

  const isNew = scope === 'new';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/50" onClick={saving ? undefined : onClose} aria-hidden />
      <form
        onSubmit={(event) => void submit(event)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="system-prompt-title"
        className="relative flex max-h-[92vh] w-full max-w-2xl flex-col rounded-t-2xl bg-white shadow-xl dark:bg-surface-800 sm:max-h-[85vh] sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-surface-100 px-5 py-4 dark:border-surface-700">
          <div className="min-w-0">
            <h2 id="system-prompt-title" className="text-lg font-semibold">System prompt</h2>
            <p className="mt-0.5 truncate text-xs text-surface-500">{threadTitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn-ghost !px-2"
            aria-label="Close system prompt editor"
          >
            <IconClose />
          </button>
        </header>

        <div className="scrollbar-thin overflow-y-auto px-5 py-5">
          <div className="mb-4 rounded-xl border border-surface-200 bg-surface-50 px-4 py-3 text-sm leading-6 text-surface-600 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300">
            {isNew ? (
              <p>
                This starts with the default from Settings. Your edit belongs to this new thread and
                is saved with it when the thread is created.
              </p>
            ) : inheritedDefault ? (
              <p>
                This older thread is currently using the default from Settings. Saving here creates
                its own snapshot, so later default changes will not affect it.
              </p>
            ) : (
              <p>
                This thread owns a prompt snapshot. Changes apply to future turns in this thread
                only; the default in Settings and other threads stay unchanged.
              </p>
            )}
          </div>
          {mode === 'code' && (
            <p className="mb-4 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3 text-xs leading-5 text-surface-600 dark:text-surface-300">
              Code mode appends its fixed workspace-editing instruction after this thread prompt.
              The Context inspector shows the complete effective prompt, including that instruction
              and any selected skills.
            </p>
          )}
          {mode !== 'chat' && enabledSkillCount > 0 && (
            <p className="mb-4 rounded-xl border border-surface-200 bg-surface-50 px-4 py-3 text-xs leading-5 text-surface-600 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300">
              {enabledSkillCount} configured skill selection{enabledSkillCount === 1 ? '' : 's'} will
              be resolved by the runtime. Available skills append instructions after this thread
              prompt. Their contents, availability, and final combined prompt are visible in Context.
            </p>
          )}

          <label className="label" htmlFor="thread-system-prompt">
            Instructions sent before the conversation
          </label>
          <textarea
            ref={textareaRef}
            id="thread-system-prompt"
            name="systemPrompt"
            rows={14}
            className="input min-h-56 resize-y font-mono text-sm leading-6"
            defaultValue={prompt}
            placeholder="No thread-authored system instructions."
            spellCheck
          />
          <p className="mt-2 text-xs leading-5 text-surface-500">
            Leave this empty to send no thread-authored system instruction. Code mode and selected
            skills may still add visible runtime instructions. Inspect the complete request and
            effective prompt from the Context control in the header.
          </p>
          {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-surface-100 px-5 py-4 dark:border-surface-700">
          <button type="button" onClick={onClose} disabled={saving} className="btn-ghost">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Save for this thread'}
          </button>
        </footer>
      </form>
    </div>
  );
}
