/**
 * Provider interface. Ported from providers/provider.go.
 *
 * Go returned `<-chan StreamEvent`; the TS equivalent is an AsyncIterable that
 * ends instead of signalling Done, and throws instead of carrying Err. Callers
 * therefore use `for await`, and the Done/Err fields of the Go StreamEvent have
 * no counterpart here by design.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, Model, StreamChunk } from './types.js';

export interface Provider {
  chatCompletion(req: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse>;

  /** Yields chunks until the upstream stream completes; throws ApiError on failure. */
  chatCompletionStream(req: ChatCompletionRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;

  listModels(signal?: AbortSignal): Promise<Model[]>;
}
