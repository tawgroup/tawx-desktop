/**
 * Shared SSE reading for OpenAI-compatible upstreams. Ported from
 * providers/streaming.go, plus the line framing that Go got from bufio.Scanner.
 */

import { Effect, Stream } from 'effect';
import { ApiError, ErrorType, asApiError, errProviderError, runSyncBoundary, type ErrorTypeValue } from './errors.js';
import type { StreamChunk } from './types.js';

/**
 * Effect version of the chunk parser. An error envelope ({"error": {...}}) is
 * failed rather than silently decoded into an all-zero chunk, so an upstream
 * mid-stream failure surfaces to the client instead of arriving as an empty
 * delta.
 */
export function parseStreamChunkEffect(data: string): Effect.Effect<StreamChunk, ApiError> {
  return Effect.flatMap(
    Effect.try({
      try: () => JSON.parse(data) as unknown,
      catch: (err) =>
        errProviderError(`failed to parse chunk: ${err instanceof Error ? err.message : String(err)}`),
    }),
    (parsed) => {
      const envelope = parsed as { error?: { message?: string; type?: string; code?: string } };
      if (envelope && typeof envelope === 'object' && envelope.error) {
        return Effect.fail(
          new ApiError(
            envelope.error.message ?? 'upstream error',
            (envelope.error.type as ErrorTypeValue) ?? ErrorType.Server,
            envelope.error.code,
          ),
        );
      }
      return Effect.succeed(parsed as StreamChunk);
    },
  );
}

/**
 * Parses one SSE data payload. Sync throw-compat shim over parseStreamChunkEffect
 * so existing callers keep working unchanged.
 */
export function parseStreamChunk(data: string): StreamChunk {
  return runSyncBoundary(parseStreamChunkEffect(data));
}

/** Core line framing, shared by the Stream and the legacy generator. */
async function* sseDataIterable(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

/**
 * SSE `data:` payloads as an Effect Stream. `[DONE]` terminates the stream,
 * matching the Go reader's behaviour.
 */
export function readSseDataStream(body: ReadableStream<Uint8Array>): Stream.Stream<string, ApiError> {
  return Stream.fromAsyncIterable(sseDataIterable(body), (err) => asApiError(err));
}

/**
 * Yields raw SSE `data:` payloads from a fetch body, splitting on newlines and
 * carrying any partial line across chunk boundaries. `[DONE]` is not yielded —
 * it terminates the iteration, matching the Go reader's behaviour.
 *
 * Kept as an async generator for existing callers; implemented over the Effect
 * Stream above.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const data of Stream.toAsyncIterable(readSseDataStream(body))) {
    yield data;
  }
}
