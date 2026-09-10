/**
 * OpenAI-compatible wire types.
 *
 * Ported from providers/types.go. Optional fields mirror Go's `omitempty`:
 * `undefined` is dropped by JSON.stringify, so an absent field serializes the
 * same way it did in Go. The one deliberate exception is `finish_reason`,
 * which Go declares without `omitempty` so intermediate streaming chunks emit
 * an explicit null — here it is required and nullable for the same reason.
 */

export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stream_options?: StreamOptions;
  /** string or string[] */
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: Tool[];
  /** string or object */
  tool_choice?: unknown;
  response_format?: ResponseFormat;
}

export interface Message {
  role: string;
  /** string or ContentPart[] */
  content: string | ContentPart[] | null;
  reasoning?: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: string;
  text?: string;
  image_url?: ImageUrl;
}

export interface ImageUrl {
  url: string;
  detail?: string;
}

export interface Tool {
  type: string;
  function?: FunctionDef;
  parameters?: unknown;
}

export interface FunctionDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Mirrors Tool.MarshalJSON in Go: ordinary function tools serialize whole,
 * while provider-operated tools (OpenRouter web search) drop "function" and
 * keep only type + parameters.
 */
export function serializeTool(tool: Tool): unknown {
  if (tool.type === 'function') return tool;
  return tool.parameters === undefined
    ? { type: tool.type }
    : { type: tool.type, parameters: tool.parameters };
}

/**
 * `index` is populated only in streaming deltas, where it identifies which
 * tool call a fragment belongs to; it is absent in non-streaming responses.
 */
export interface ToolCall {
  index?: number;
  id?: string;
  type?: string;
  function: FunctionCall;
}

/**
 * `name`/`arguments` are optional so streaming argument fragments serialize as
 * {"index":N,"function":{"arguments":"..."}} without empty leading fields.
 */
export interface FunctionCall {
  name?: string;
  arguments?: string;
}

export interface ResponseFormat {
  type: string;
}

export interface StreamOptions {
  include_usage?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
  system_fingerprint?: string;
}

export interface Choice {
  index: number;
  message?: Message;
  delta?: Delta;
  /** null on intermediate streaming chunks — never omitted. */
  finish_reason: string | null;
}

export interface Delta {
  role?: string;
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost?: number;
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
  system_fingerprint?: string;
}

export interface ModelsResponse {
  object: string;
  data: Model[];
}

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  architecture?: {
    input_modalities?: string[];
  };
}

/** Extracts string content from a message; '' when content is multi-part. */
export function getContentString(message: Message): string {
  return typeof message.content === 'string' ? message.content : '';
}
