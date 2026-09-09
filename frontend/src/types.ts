export type Role = 'system' | 'user' | 'assistant';
export type AppMode = 'chat' | 'cowork';
export type CoworkSection = 'tasks' | 'schedules' | 'tools' | 'skills';

export interface Message {
  id: string;
  chatId: string;
  role: Role;
  content: string;
  /** Local project snapshot sent to the model but hidden from the chat transcript. */
  context?: string;
  createdAt: number;
  /** Populated when the assistant turn failed; renders inline as an error bubble. */
  error?: string;
  model?: string;
  reasoning?: string;
  cost?: number;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Per-chat override; falls back to global settings when undefined. */
  model?: string;
  systemPrompt?: string;
}

export interface Provider {
  id: string;
  name: string;
  /** Base URL up to and including /v1, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  providers: Provider[];
  activeProviderId: string | null;
  temperature: number;
  maxTokens: number | null;
  systemPrompt: string;
  theme: 'light' | 'dark' | 'system';
  streaming: boolean;
  sendOnEnter: boolean;
  webSearch: boolean;
  webSearchEngine: WebSearchEngine;
}

export type WebSearchEngine = 'auto' | 'exa' | 'parallel' | 'perplexity';

export interface ModelInfo {
  id: string;
  owned_by?: string;
}

/** Wire format for the OpenAI-compatible chat completions endpoint. */
export interface ChatCompletionMessage {
  role: Role;
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface StreamDelta {
  model?: string;
  usage?: { cost?: number };
  choices?: Array<{
    delta?: { content?: string; reasoning?: string; role?: Role };
    finish_reason?: string | null;
  }>;
}

export interface CompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  usage?: { cost?: number };
}

export const DEFAULT_SETTINGS: Settings = {
  providers: [{ id: 'gateway', name: 'LLM Gateway', baseUrl: '/v1', apiKey: 'not-needed', model: 'auto' }],
  activeProviderId: 'gateway',
  temperature: 1,
  maxTokens: null,
  systemPrompt: '',
  theme: 'system',
  streaming: true,
  sendOnEnter: true,
  webSearch: false,
  webSearchEngine: 'auto',
};
