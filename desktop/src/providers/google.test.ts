import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleProvider } from './google.js';

const MODEL_RESPONSE = {
  object: 'list',
  data: [{ id: 'gemini-3.1-flash-lite', object: 'model', created: 0, owned_by: 'google' }],
};

const COMPLETION_RESPONSE = {
  id: 'completion',
  object: 'chat.completion',
  created: 0,
  model: 'gemini-3.1-flash-lite',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

test('Google provider uses Gemini OpenAI compatibility paths without an extra v1 segment', async () => {
  const urls: string[] = [];
  const provider = new GoogleProvider({
    apiKey: 'test-key',
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      const body = url.endsWith('/models') ? MODEL_RESPONSE : COMPLETION_RESPONSE;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await provider.listModels();
  await provider.chatCompletion({
    model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.deepEqual(urls, [
    'https://generativelanguage.googleapis.com/v1beta/openai/models',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  ]);
});
