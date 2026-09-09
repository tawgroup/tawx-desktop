/**
 * Shared SSE reading for OpenAI-compatible upstreams. Ported from
 * providers/streaming.go, plus the line framing that Go got from bufio.Scanner.
 */

import { ApiError, ErrorType, errProviderError, type ErrorTypeValue } from './errors.js';
import type { StreamChunk } from './types.js';

/**
 * Parses one SSE data payload. An error envelope ({"error": {...}}) is thrown
 * rather than silently decoded into an all-zero chunk, so an upstream mid-stream
 * failure surfaces to the client instead of arriving as an empty delta.
 */
export function parseStreamChunk(data: string): StreamChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw errProviderError(`failed to parse chunk: ${err instanceof Error ? err.message : String(err)}`);
  }

  const envelope = parsed as { error?: { message?: string; type?: string; code?: string } };
  if (envelope && typeof envelope === 'object' && envelope.error) {
    throw new ApiError(
      envelope.error.message ?? 'upstream error',
      (envelope.error.type as ErrorTypeValue) ?? ErrorType.Server,
      envelope.error.code,
    );
  }
  return parsed as StreamChunk;
}

/**
 * Yields raw SSE `data:` payloads from a fetch body, splitting on newlines and
 * carrying any partial line across chunk boundaries. `[DONE]` is not yielded —
 * it terminates the iteration, matching the Go reader's behaviour.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffered += decoder.decode(value, { stream: true });
      // Keep the trailing fragment: it is only a complete line once the next
      // read supplies its newline.
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (data === '[DONE]') return;
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
