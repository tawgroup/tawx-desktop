/**
 * Lightweight streaming-perf recorder (dev A/B tool, no dependencies).
 *
 * Purpose: prove — with numbers, not feelings — that the SolidJS
 * streaming island is cheaper than re-parsing markdown on every token.
 *
 * How to A/B test (same build, same prompt, twice):
 *   1. Open DevTools in the app: Cmd+Option+I → Console tab.
 *   2. Run a long streaming answer, watch the `console.table` summary
 *      printed when the stream finishes.
 *   3. Switch mode and reload:
 *        localStorage.setItem('tawx:streamMode', 'react');  // old path
 *        localStorage.setItem('tawx:streamMode', 'solid');  // new path (default)
 *      then View → Reload, and run the SAME prompt again.
 *   4. Compare `avgMsPerUpdate` and `maxMsPerUpdate`.
 *
 * What is measured: for every streamed token update, t0 is captured at
 * the top of MessageBubble's render and the delta is closed in a
 * useEffect after React commits — so each sample covers render +
 * commit of the streaming bubble (including the full ReactMarkdown
 * re-parse in `react` mode).
 */

export type StreamMode = 'solid' | 'react';

const MODE_KEY = 'tawx:streamMode';

export function getStreamMode(): StreamMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'react' ? 'react' : 'solid';
  } catch {
    return 'solid';
  }
}

interface StreamStats {
  mode: StreamMode;
  updates: number;
  totalMs: number;
  maxMs: number;
  chars: number;
  markdownParses: number;
}

let active: StreamStats | null = null;

export function streamRenderStart(): number {
  return performance.now();
}

export function streamRenderEnd(t0: number, chars: number, parsedMarkdown: boolean): void {
  const dt = performance.now() - t0;
  if (!active) {
    active = { mode: getStreamMode(), updates: 0, totalMs: 0, maxMs: 0, chars: 0, markdownParses: 0 };
  }
  active.updates += 1;
  active.totalMs += dt;
  if (dt > active.maxMs) active.maxMs = dt;
  if (chars > active.chars) active.chars = chars;
  if (parsedMarkdown) active.markdownParses += 1;
}

/** Call when a stream finishes: prints the summary table, resets. */
export function streamFinish(messageLabel: string): void {
  if (!active || active.updates === 0) {
    active = null;
    return;
  }
  const { mode, updates, totalMs, maxMs, chars, markdownParses } = active;
  active = null;
  // eslint-disable-next-line no-console
  console.table({
    mode,
    message: messageLabel,
    tokenUpdates: updates,
    charsStreamed: chars,
    markdownParses,
    avgMsPerUpdate: +(totalMs / updates).toFixed(3),
    maxMsPerUpdate: +maxMs.toFixed(3),
    totalMs: +totalMs.toFixed(1),
  });
  // eslint-disable-next-line no-console
  console.log(
    `%c[perf] mode=${mode}. Switch with localStorage.setItem('tawx:streamMode','${mode === 'solid' ? 'react' : 'solid'}') then reload.`,
    'color:#888',
  );
}
