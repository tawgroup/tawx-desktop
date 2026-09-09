import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactChatForPersistence,
  redactMessageForPersistence,
  redactSettingsForPersistence,
  redactTaskForPersistence,
} from '../src/lib/redaction.ts';
import { parseDesktopTaskEvent } from '../src/lib/api.ts';
import { DEFAULT_SETTINGS, type CoworkTask, type Message } from '../src/types.ts';

const RAW_KEY = 'sk-abcdefghijklmnopqrstuvwxyz123456';

test('persistence clones redact prompts, message secrets, and secret-named attachment text without mutating live state', () => {
  const message: Message = {
    id: 'message-1',
    chatId: 'thread-1',
    role: 'user',
    content: `Use api_key=${RAW_KEY}`,
    context: `Authorization: Bearer ${RAW_KEY}`,
    reasoning: `password: "${RAW_KEY}"`,
    createdAt: 1,
    attachments: [
      { id: 'env', name: '.env.local', mimeType: 'text/plain', size: 10, kind: 'text', text: `DATABASE_PASSWORD=${RAW_KEY}` },
      { id: 'notes', name: 'notes.txt', mimeType: 'text/plain', size: 10, kind: 'text', text: `token=${RAW_KEY}\nkeep this line` },
    ],
  };
  const chat = { id: 'thread-1', title: `Task ${RAW_KEY}`, createdAt: 1, updatedAt: 1, systemPrompt: `credential=${RAW_KEY}` };

  const persistedMessage = redactMessageForPersistence(message);
  const persistedChat = redactChatForPersistence(chat);
  assert.match(persistedMessage.content, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(persistedMessage), new RegExp(RAW_KEY));
  assert.equal(persistedMessage.attachments?.[0]?.text, '[REDACTED: sensitive attachment content]');
  assert.match(persistedMessage.attachments?.[1]?.text ?? '', /keep this line/);
  assert.equal(message.content, `Use api_key=${RAW_KEY}`);
  assert.equal(message.attachments?.[0]?.text, `DATABASE_PASSWORD=${RAW_KEY}`);
  assert.equal(persistedChat.systemPrompt, 'credential=[REDACTED]');
  assert.equal(chat.systemPrompt, `credential=${RAW_KEY}`);
  assert.doesNotMatch(persistedChat.title, new RegExp(RAW_KEY));
});

test('task event normalization redacts inspectable audit payloads before they enter state', () => {
  const event = parseDesktopTaskEvent(JSON.stringify({
    id: 1,
    taskId: 'task-1',
    kind: 'tool_call',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { arguments: { token: RAW_KEY }, command: `API_KEY=${RAW_KEY} tool` },
  }));

  assert.ok(event);
  const payload = event.payload as Record<string, unknown>;
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(RAW_KEY));
  assert.equal((payload.arguments as Record<string, unknown>).token, '[REDACTED]');
});

test('task persistence recursively redacts audit values while preserving token accounting', () => {
  const task: CoworkTask = {
    id: 'task-1',
    threadId: 'thread-1',
    status: 'completed',
    mode: 'cowork',
    systemPrompt: `password=${RAW_KEY}`,
    policy: 'ask',
    enabledTools: ['read_file'],
    enabledSkillIds: [],
    createdAt: 1,
    updatedAt: 2,
    events: [{
      id: '1',
      taskId: 'task-1',
      kind: 'tool_result',
      timestamp: 2,
      payload: { access_token: RAW_KEY, inputTokens: 12, output: `Bearer ${RAW_KEY}` },
    }],
    todos: [],
    toolCalls: [],
    approvals: [],
    diffs: [{ id: 'diff-1', path: '.env', diff: `+API_KEY=${RAW_KEY}`, timestamp: 2 }],
    artifacts: [{ id: 'artifact-1', name: 'result.txt', type: 'text/plain', content: `secret=${RAW_KEY}`, createdAt: 2 }],
    context: { usedTokens: 12, maxTokens: 100, remainingTokens: 88, compactedMessages: 0, compactionCount: 0, updatedAt: 2 },
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    assistantContent: `Result ${RAW_KEY}`,
    reasoning: `Authorization: Bearer ${RAW_KEY}`,
  };

  const persisted = redactTaskForPersistence(task);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(RAW_KEY));
  const firstEvent = persisted.events[0];
  assert.ok(firstEvent);
  assert.equal((firstEvent.payload as Record<string, unknown>).inputTokens, 12);
  assert.equal(persisted.usage.totalTokens, 15);
  assert.equal(task.systemPrompt, `password=${RAW_KEY}`);
});

test('settings persistence redacts the default prompt but keeps provider credentials in their existing config store', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: [{ ...DEFAULT_SETTINGS.providers[0], apiKey: RAW_KEY }],
    systemPrompt: `api_key=${RAW_KEY}`,
  };
  const persisted = redactSettingsForPersistence(settings);

  assert.equal(persisted.systemPrompt, 'api_key=[REDACTED]');
  assert.equal(persisted.providers[0]?.apiKey, RAW_KEY);
  assert.equal(settings.systemPrompt, `api_key=${RAW_KEY}`);
});
