/**
 * Request serialization for OpenAI-compatible upstreams.
 *
 * Go got this for free: `Tool.MarshalJSON` ran automatically inside
 * `json.Marshal`. TypeScript has no such hook, so every provider that sends a
 * request must route it through here or provider-operated tools (OpenRouter
 * web search) would go out with a bogus empty "function" field.
 */

import { serializeTool } from './types.js';
import type { ChatCompletionRequest } from './types.js';

export function serializeRequest(req: ChatCompletionRequest, stream: boolean): string {
  const wire: Record<string, unknown> = { ...req, stream };
  if (req.tools) wire.tools = req.tools.map(serializeTool);
  return JSON.stringify(wire);
}
