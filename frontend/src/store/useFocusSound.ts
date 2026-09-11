import { create } from 'zustand';
import type { FocusSoundId } from '../types';
import { clampVolume, focusSound } from '../lib/focusSound';
import { useSettings } from './useSettings';

/** How long to let the slider settle before writing the level to storage. */
const PERSIST_DELAY_MS = 400;

interface FocusSoundState {
  /** The preset currently sounding, or null when silent. */
  playing: FocusSoundId | null;
  /**
   * The level being dragged right now. Settings hold the saved level; this
   * holds the in-flight one so the slider tracks the pointer without a write
   * per pixel.
   */
  pendingVolume: number | null;
  toggle: (id: FocusSoundId) => void;
  stop: () => void;
  setVolume: (volume: number) => void;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

export const useFocusSound = create<FocusSoundState>((set, get) => ({
  playing: null,
  pendingVolume: null,

  toggle: (id) => {
    if (get().playing === id) {
      get().stop();
      return;
    }
    const settings = useSettings.getState();
    const volume = get().pendingVolume ?? settings.settings.focusSoundVolume;
    void focusSound.play(id, volume);
    set({ playing: id });
    if (settings.settings.focusSoundPreset !== id) void settings.update({ focusSoundPreset: id });
  },

  stop: () => {
    focusSound.stop();
    set({ playing: null });
  },

  setVolume: (volume) => {
    const clamped = clampVolume(volume);
    focusSound.setVolume(clamped);
    set({ pendingVolume: clamped });
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void useSettings.getState().update({ focusSoundVolume: clamped });
    }, PERSIST_DELAY_MS);
  },
}));
