import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

const shortcuts = [
  ['New chat', '⌘N'],
  ['Previous / next chat', '⌘[  /  ⌘]'],
  ['Chat / Cowork / Code', '⌘1  /  ⌘2  /  ⌘3'],
  ['Search chats', '⌘K'],
  ['Focus composer', '⇧⌘K'],
  ['Settings', '⌘,'],
  ['Context inspector', '⌥⌘X'],
  ['Toggle sidebar', '⌥⌘S'],
  ['Stop generation', '⌘.'],
  ['Send / newline', 'Return  /  ⇧Return'],
] as const;

export default function ShortcutHelp({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="w-full max-w-lg rounded-2xl border border-surface-200 bg-surface-0 p-5 shadow-2xl dark:border-surface-700 dark:bg-surface-900"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="shortcut-help-title" className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} className="btn-ghost !px-2" aria-label="Close keyboard shortcuts">×</button>
        </div>
        <dl className="divide-y divide-surface-200 dark:divide-surface-800">
          {shortcuts.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between gap-6 py-2.5 text-sm">
              <dt>{label}</dt>
              <dd className="whitespace-pre rounded-md bg-surface-100 px-2 py-1 font-mono text-xs text-surface-600 dark:bg-surface-800 dark:text-surface-300">{keys}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-surface-500">Shortcuts apply while TAWX Desktop is focused.</p>
      </section>
    </div>
  );
}
