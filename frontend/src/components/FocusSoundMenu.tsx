import { useEffect, useRef, useState } from 'react';
import { FOCUS_SOUNDS } from '../lib/focusSound';
import { useFocusSound } from '../store/useFocusSound';
import { useSettings } from '../store/useSettings';
import { cn } from '../lib/utils';
import { IconSound } from './Icons';

/**
 * Ambient sound control: a sidebar-footer button opening a small popover of
 * synthesised presets. Playback lives in a store rather than here, so it keeps
 * running while the sidebar is collapsed or the mode changes.
 */
export default function FocusSoundMenu() {
  const playing = useFocusSound((s) => s.playing);
  const pendingVolume = useFocusSound((s) => s.pendingVolume);
  const toggle = useFocusSound((s) => s.toggle);
  const stop = useFocusSound((s) => s.stop);
  const setVolume = useFocusSound((s) => s.setVolume);
  const savedPreset = useSettings((s) => s.settings.focusSoundPreset);
  const savedVolume = useSettings((s) => s.settings.focusSoundVolume);

  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const volume = pendingVolume ?? savedVolume;
  const highlighted = playing ?? savedPreset;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors',
          open ? 'bg-surface-100 dark:bg-surface-800' : 'hover:bg-surface-100 dark:hover:bg-surface-800',
        )}
        title="Focus sounds"
      >
        <IconSound className="h-4 w-4" />
        Focus sounds
        {playing && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
            On
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Focus sounds"
          className="absolute bottom-full left-0 z-50 mb-2 w-[236px] rounded-xl border border-surface-200
                     bg-surface-50 p-2 shadow-lg dark:border-surface-700 dark:bg-surface-800"
        >
          <ul className="space-y-0.5">
            {FOCUS_SOUNDS.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={playing === preset.id}
                  onClick={() => toggle(preset.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                    playing === preset.id
                      ? 'bg-accent/10 text-accent'
                      : 'hover:bg-surface-100 dark:hover:bg-surface-700',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      playing === preset.id
                        ? 'animate-pulse bg-accent'
                        : highlighted === preset.id
                          ? 'bg-surface-400'
                          : 'bg-transparent',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{preset.label}</span>
                    <span className="block truncate text-xs text-surface-500 dark:text-surface-400">{preset.hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-surface-200 px-2.5 pt-2.5 dark:border-surface-700">
            <label className="flex items-center gap-2.5 text-xs text-surface-500 dark:text-surface-400">
              <span className="sr-only">Volume</span>
              <IconSound className="h-3.5 w-3.5 shrink-0" />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => setVolume(event.target.valueAsNumber)}
                aria-label="Focus sound volume"
                className="h-1 flex-1 cursor-pointer accent-accent"
              />
              <span className="w-8 shrink-0 text-right tabular-nums">{Math.round(volume * 100)}%</span>
            </label>

            {playing && (
              <button
                type="button"
                onClick={stop}
                className="mt-2 w-full rounded-lg px-2.5 py-1.5 text-xs font-medium text-surface-600
                           transition-colors hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-700"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
