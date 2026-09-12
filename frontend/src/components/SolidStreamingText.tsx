import { useEffect, useRef } from 'react';
import { createEffect, createRoot, createSignal } from 'solid-js';

interface Props {
  text: string;
  className?: string;
}

/**
 * SolidJS reactivity island inside the React tree (pilot for the
 * React → SolidJS migration).
 *
 * Why this exists: while an answer streams, the store pushes a new token
 * ~30×/s. The old path re-rendered the whole bubble and re-parsed the
 * ENTIRE markdown document via ReactMarkdown on every token (O(n²) work
 * as the message grows). This island instead:
 *
 * - mounts once, never re-renders (no useState for the text),
 * - pushes each token into a Solid signal,
 * - a Solid effect writes it straight to the real DOM text node —
 *   no Virtual DOM, no diffing (fine-grained reactivity).
 *
 * When streaming ends the parent swaps back to ReactMarkdown, so the
 * finished message renders exactly as before.
 */
export default function SolidStreamingText({ text, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pushRef = useRef<((value: string) => void) | null>(null);

  // Mount once on purpose: the Solid root owns the text node for the
  // whole lifetime of the stream. React never touches it again.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dispose = createRoot((disposeRoot) => {
      const [value, setValue] = createSignal(text);
      pushRef.current = setValue;
      createEffect(() => {
        el.textContent = value();
      });
      return disposeRoot;
    });
    return () => {
      pushRef.current = null;
      dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Token update: straight into the Solid signal. No setState here,
  // so this component itself never re-renders for token updates —
  // only the cheap parent render passes a new `text` prop down.
  useEffect(() => {
    pushRef.current?.(text);
  }, [text]);

  return <div ref={ref} className={className} />;
}
