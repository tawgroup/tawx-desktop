import type { FocusSoundId } from '../types';

/**
 * Ambient focus sounds, synthesised rather than streamed.
 *
 * Every preset is filtered white noise: no audio files to ship, nothing to
 * fetch at runtime, and no licence to track. The whole engine is one lazily
 * created AudioContext that stays suspended whenever nothing is playing.
 */

export interface FocusSoundPreset {
  id: FocusSoundId;
  label: string;
  hint: string;
}

export const FOCUS_SOUNDS: readonly FocusSoundPreset[] = [
  { id: 'rain', label: 'Rain', hint: 'Steady rainfall' },
  { id: 'ocean', label: 'Ocean', hint: 'Waves rolling in' },
  { id: 'stream', label: 'Stream', hint: 'Water over stones' },
  { id: 'wind', label: 'Wind', hint: 'Air through trees' },
  { id: 'deep', label: 'Deep noise', hint: 'Low hum, masks voices' },
];

export const isFocusSoundId = (value: string): value is FocusSoundId =>
  FOCUS_SOUNDS.some((preset) => preset.id === value);

export const clampVolume = (volume: number): number => (
  Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0
);

/**
 * Loudness rises far faster than the slider position, so a linear slider spends
 * most of its travel too loud. Squaring it gives an even-feeling sweep.
 */
export const gainForVolume = (volume: number): number => clampVolume(volume) ** 2;

/** Ramps are never taken to zero: an exponential-friendly floor avoids clicks. */
const SILENT = 0.0001;
const FADE_SECONDS = 0.4;
const NOISE_SECONDS = 8;

let noiseBuffer: AudioBuffer | null = null;

/**
 * One shared noise buffer, looped. White noise is already random, so the loop
 * point is inaudible — unlike integrated (brown) noise, which clicks at the
 * seam. Darker colours come from filtering this buffer instead.
 */
function whiteNoise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

function noise(ctx: AudioContext): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = whiteNoise(ctx);
  source.loop = true;
  return source;
}

function band(ctx: AudioContext, type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

function level(ctx: AudioContext, value: number): GainNode {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

/** Adds a slow swell to an AudioParam; the param's own value stays the centre. */
function sway(ctx: AudioContext, frequency: number, depth: number, target: AudioParam): OscillatorNode {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  const amount = level(ctx, depth);
  osc.connect(amount).connect(target);
  return osc;
}

type Voice = (ctx: AudioContext, out: AudioNode) => AudioScheduledSourceNode[];

const voices: Record<FocusSoundId, Voice> = {
  rain: (ctx, out) => {
    const body = noise(ctx);
    body.connect(band(ctx, 'lowpass', 3200, 0.6)).connect(level(ctx, 0.9)).connect(out);

    // A brighter layer riding on top reads as spatter rather than hiss, and the
    // slow drift keeps the shower from sounding like a frozen sample.
    const spatter = noise(ctx);
    const spatterLevel = level(ctx, 0.14);
    spatter.connect(band(ctx, 'highpass', 2600, 0.5)).connect(spatterLevel).connect(out);

    return [body, spatter, sway(ctx, 0.05, 0.07, spatterLevel.gain)];
  },

  ocean: (ctx, out) => {
    const surf = noise(ctx);
    const swell = level(ctx, 0.9);
    surf.connect(band(ctx, 'lowpass', 460, 0.4)).connect(swell).connect(out);

    // Roughly one wave every eleven seconds, never falling all the way silent.
    const foam = noise(ctx);
    const foamLevel = level(ctx, 0.1);
    foam.connect(band(ctx, 'bandpass', 1800, 0.8)).connect(foamLevel).connect(out);

    return [
      surf,
      foam,
      sway(ctx, 0.09, 0.5, swell.gain),
      sway(ctx, 0.09, 0.07, foamLevel.gain),
    ];
  },

  stream: (ctx, out) => {
    const flow = noise(ctx);
    flow.connect(band(ctx, 'lowpass', 900, 0.5)).connect(level(ctx, 0.7)).connect(out);

    const trickle = noise(ctx);
    const trickleFilter = band(ctx, 'bandpass', 1500, 1.4);
    trickle.connect(trickleFilter).connect(level(ctx, 0.5)).connect(out);

    return [flow, trickle, sway(ctx, 0.23, 380, trickleFilter.frequency)];
  },

  wind: (ctx, out) => {
    const gust = noise(ctx);
    const gustFilter = band(ctx, 'bandpass', 560, 1.1);
    const gustLevel = level(ctx, 0.85);
    gust.connect(gustFilter).connect(gustLevel).connect(out);

    return [gust, sway(ctx, 0.06, 260, gustFilter.frequency), sway(ctx, 0.04, 0.3, gustLevel.gain)];
  },

  deep: (ctx, out) => {
    // Cutting everything above ~180 Hz throws away most of the energy, so this
    // one needs a good deal more gain to sit at the same loudness as the rest.
    const hum = noise(ctx);
    hum.connect(band(ctx, 'lowpass', 180, 0.5)).connect(level(ctx, 4)).connect(out);
    return [hum];
  },
};

interface Session {
  master: GainNode;
  sources: AudioScheduledSourceNode[];
}

export interface FocusSoundEngine {
  play: (id: FocusSoundId, volume: number) => Promise<void>;
  stop: () => void;
  setVolume: (volume: number) => void;
}

/**
 * @param createContext injection seam for tests; the browser default is only
 * touched on the first play, so importing this module stays side-effect free.
 */
export function createFocusSoundEngine(
  createContext: () => AudioContext = () => new AudioContext(),
): FocusSoundEngine {
  let ctx: AudioContext | null = null;
  let session: Session | null = null;

  /** Fades a session out and tears it down once the ramp has finished. */
  function release(context: AudioContext, ending: Session): void {
    const now = context.currentTime;
    ending.master.gain.cancelScheduledValues(now);
    ending.master.gain.setValueAtTime(ending.master.gain.value, now);
    ending.master.gain.linearRampToValueAtTime(SILENT, now + FADE_SECONDS);
    for (const source of ending.sources) source.stop(now + FADE_SECONDS + 0.05);
    setTimeout(() => {
      ending.master.disconnect();
      // Only park the context if nothing started in the meantime.
      if (!session) void context.suspend();
    }, (FADE_SECONDS + 0.15) * 1000);
  }

  return {
    async play(id, volume) {
      const context = ctx ?? (ctx = createContext());
      const previous = session;
      session = null;
      if (previous) release(context, previous);
      if (context.state === 'suspended') await context.resume();

      const master = context.createGain();
      master.gain.value = SILENT;
      master.connect(context.destination);
      const sources = voices[id](context, master);

      const now = context.currentTime;
      master.gain.setValueAtTime(SILENT, now);
      master.gain.linearRampToValueAtTime(Math.max(gainForVolume(volume), SILENT), now + FADE_SECONDS);
      for (const source of sources) source.start();
      session = { master, sources };
    },

    stop() {
      const current = session;
      if (!ctx || !current) return;
      session = null;
      release(ctx, current);
    },

    setVolume(volume) {
      if (!ctx || !session) return;
      const now = ctx.currentTime;
      session.master.gain.cancelScheduledValues(now);
      session.master.gain.setValueAtTime(session.master.gain.value, now);
      session.master.gain.linearRampToValueAtTime(Math.max(gainForVolume(volume), SILENT), now + 0.08);
    },
  };
}

export const focusSound = createFocusSoundEngine();
