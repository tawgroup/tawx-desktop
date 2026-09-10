import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDesktopTaskEvent } from '../src/lib/api.ts';
import { compactMessages, estimateMessageTokens, serializeMessage } from '../src/lib/project.ts';
import {
  CODE_MODE_INSTRUCTION,
  contextBudgetError,
  type ChatState,
  selectContextPreview,
} from '../src/store/useChats.ts';
import { createCoworkTask, reduceTaskEvent, taskFromSnapshot } from '../src/store/taskReducer.ts';
import type { DesktopTaskRequest, TaskEvent } from '../src/types.ts';

const REQUEST: DesktopTaskRequest = {
  threadId: 'thread-1',
  mode: 'cowork',
  messages: [{ role: 'user', content: 'Update the docs' }],
  systemPrompt: 'Be concise',
  workspace: { path: '/repo', name: 'repo' },
  policy: 'ask',
  enabledTools: ['read_file', 'write_file'],
  enabledSkillIds: ['developer'],
};

test('serializes persisted image and readable-file attachments as OpenAI content parts', () => {
  const message = serializeMessage({
    role: 'user',
    content: 'Review these',
    attachments: [
      { id: 'image', name: 'screen.png', mimeType: 'image/png', size: 12, kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
      { id: 'text', name: 'notes.txt', mimeType: 'text/plain', size: 9, kind: 'text', text: 'safe notes', truncated: true },
    ],
  });

  assert.equal(Array.isArray(message.content), true);
  assert.deepEqual(Array.isArray(message.content) ? message.content[1] : null, {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAAA' },
  });
  assert.match(Array.isArray(message.content) && message.content[2]?.type === 'text' ? message.content[2].text : '', /Attached file: notes\.txt/);
  assert.match(Array.isArray(message.content) && message.content[2]?.type === 'text' ? message.content[2].text : '', /safe notes/);
});

test('attachment-only messages omit a meaningless empty text part', () => {
  const message = serializeMessage({
    role: 'user',
    content: '',
    attachments: [{ id: 'image', name: 'screen.png', mimeType: 'image/png', size: 12, kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }],
  });
  assert.deepEqual(message.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
});

test('serializes cached vision evidence instead of images for text-only destinations', () => {
  const message = serializeMessage({
    role: 'user',
    content: 'What failed?',
    attachments: [{ id: 'image', name: 'error.png', mimeType: 'image/png', size: 12, kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }],
    visionAnalysis: {
      text: 'HTTP 400: image input unsupported',
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      model: 'google/gemini-3.1-flash-lite',
      attachmentIds: ['image'],
      promptVersion: 1,
      createdAt: 100,
    },
  }, { useVisionAnalysis: true });

  assert.equal(Array.isArray(message.content), true);
  assert.equal(Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'), false);
  const evidence = Array.isArray(message.content) && message.content.at(-1)?.type === 'text'
    ? message.content.at(-1)!.text
    : '';
  assert.match(evidence, /UNTRUSTED IMAGE-DERIVED EVIDENCE/);
  assert.match(evidence, /HTTP 400: image input unsupported/);
});

test('context compaction preserves system instructions and the newest turn', () => {
  const compacted = compactMessages([
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'x'.repeat(400) },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'new request' },
  ], 15, 2, 100);

  assert.deepEqual(compacted.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'new request' },
  ]);
  assert.equal(compacted.budget.compactedMessages, 2);
  assert.equal(compacted.budget.compactionCount, 3);
  assert.equal(compacted.budget.lastCompactedAt, 100);
});

test('Cowork context preview counts the top-level prompt and retains represented attachments', () => {
  const context = {
    usedTokens: 0,
    maxTokens: 5_000,
    remainingTokens: 5_000,
    compactedMessages: 0,
    compactionCount: 0,
    updatedAt: 1,
  };
  const historical = { id: 'old', name: 'old.txt', mimeType: 'text/plain', size: 3, kind: 'text' as const, text: 'old' };
  const pending = { id: 'new', name: 'new.png', mimeType: 'image/png', size: 3, kind: 'image' as const, dataUrl: 'data:image/png;base64,AAAA' };
  const preview = selectContextPreview({
    activeChat: {
      id: 'thread-1',
      title: 'Task',
      createdAt: 1,
      updatedAt: 1,
      mode: 'cowork',
      systemPrompt: 'Count this top-level prompt',
      policy: 'ask',
      enabledTools: [],
      enabledSkillIds: [],
      context,
    },
    draftThread: { mode: 'cowork', systemPrompt: '', policy: 'ask', enabledTools: [], enabledSkillIds: [], context },
    messages: [{ id: 'message-1', chatId: 'thread-1', role: 'user', content: 'request', attachments: [historical], createdAt: 1 }],
    attachments: [pending],
    context,
  } as unknown as ChatState);

  assert.notEqual(preview.messages[0]?.role, 'system');
  assert.deepEqual(preview.attachments.map((attachment) => attachment.id), ['old', 'new']);
  assert.ok(preview.budget.usedTokens > preview.messages.reduce((total, message) => total + estimateMessageTokens(message), 0));
});

test('Code mode appends its effective instruction exactly once without mutating user prompt text', () => {
  const context = {
    usedTokens: 0,
    maxTokens: 5_000,
    remainingTokens: 5_000,
    compactedMessages: 0,
    compactionCount: 0,
    updatedAt: 1,
  };
  const userPrompt = 'Follow repository conventions.';
  const activeChat = {
    id: 'code-thread',
    title: 'Code task',
    createdAt: 1,
    updatedAt: 1,
    mode: 'code' as const,
    systemPrompt: userPrompt,
    workspace: { path: '/repo', name: 'repo' },
    policy: 'ask' as const,
    enabledTools: ['read_file'],
    enabledSkillIds: [],
    context,
  };
  const preview = selectContextPreview({
    activeChat,
    draftThread: { mode: 'code', systemPrompt: userPrompt, workspace: activeChat.workspace, policy: 'ask', enabledTools: [], enabledSkillIds: [], context },
    messages: [{ id: 'message-1', chatId: activeChat.id, role: 'user', content: 'Make the change', createdAt: 1 }],
    attachments: [],
    context,
  } as unknown as ChatState);

  assert.equal(preview.systemPrompt.split(CODE_MODE_INSTRUCTION).length - 1, 1);
  assert.equal(preview.systemPrompt, `${userPrompt}\n\n${CODE_MODE_INSTRUCTION}`);
  assert.equal(activeChat.systemPrompt, userPrompt);
  assert.notEqual(preview.messages[0]?.role, 'system');
});

test('over-budget protected context is rejected, while the exact boundary is accepted', () => {
  const protectedContext = compactMessages([
    { role: 'system', content: 's'.repeat(80) },
    { role: 'user', content: 'u'.repeat(80) },
  ], 10, 0, 1);

  assert.ok(protectedContext.budget.usedTokens > protectedContext.budget.maxTokens);
  assert.match(contextBudgetError(protectedContext.budget) ?? '', /Context is too large/);
  assert.equal(contextBudgetError({ usedTokens: 10, maxTokens: 10 }), null);
});

test('normalizes the desktop runtime numeric event id and ISO timestamp', () => {
  const event = parseDesktopTaskEvent(JSON.stringify({
    id: 7,
    taskId: 'task-1',
    kind: 'assistant_delta',
    timestamp: '2026-09-09T12:00:00.000Z',
    payload: { text: 'hello' },
  }));

  assert.deepEqual(event, {
    id: '7',
    taskId: 'task-1',
    kind: 'assistant_delta',
    timestamp: Date.parse('2026-09-09T12:00:00.000Z'),
    payload: { text: 'hello' },
  });
});

test('task event reduction is deterministic and idempotent across the full task timeline', () => {
  const events: TaskEvent[] = [
    { id: '1', taskId: 'task-1', kind: 'status', timestamp: 2, payload: { state: 'running' } },
    { id: '2', taskId: 'task-1', kind: 'todo', timestamp: 3, payload: { id: 'todo-1', text: 'Edit file', status: 'in_progress' } },
    { id: '3', taskId: 'task-1', kind: 'tool_call', timestamp: 4, payload: { toolCallId: 'call-1', name: 'write_file', arguments: { path: 'README.md' } } },
    { id: '4', taskId: 'task-1', kind: 'approval_required', timestamp: 5, payload: { approvalId: 'approval-1', toolCallId: 'call-1', name: 'write_file', descriptor: { risk: 'write' } } },
    { id: '5', taskId: 'task-1', kind: 'status', timestamp: 6, payload: { state: 'running', approval: { id: 'approval-1', decision: 'allow_once', toolCallId: 'call-1' } } },
    { id: '6', taskId: 'task-1', kind: 'tool_result', timestamp: 7, payload: { toolCallId: 'call-1', name: 'write_file', ok: true, output: 'saved' } },
    { id: '7', taskId: 'task-1', kind: 'file_diff', timestamp: 8, payload: { toolCallId: 'call-1', checkpointId: 'checkpoint-1', diff: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n' } },
    { id: '8', taskId: 'task-1', kind: 'artifact', timestamp: 9, payload: { artifact: { id: 'artifact-1', path: 'reports/result.md', mimeType: 'text/markdown', size: 10, preview: { kind: 'text', content: 'result' } } } },
    { id: '9', taskId: 'task-1', kind: 'context', timestamp: 10, payload: { compacted: true, omittedMessages: 2, approximateCharacters: 400 } },
    { id: '10', taskId: 'task-1', kind: 'usage', timestamp: 11, payload: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    { id: '11', taskId: 'task-1', kind: 'assistant_delta', timestamp: 12, payload: { text: 'Done' } },
    { id: '12', taskId: 'task-1', kind: 'done', timestamp: 13, payload: { state: 'completed' } },
  ];

  const initial = createCoworkTask('task-1', REQUEST, 1_000, 1);
  const reduced = events.reduce(reduceTaskEvent, initial);
  const replayedDuplicate = reduceTaskEvent(reduced, events[11]);

  assert.equal(reduced.status, 'completed');
  assert.equal(reduced.todos[0]?.status, 'in_progress');
  assert.equal(reduced.toolCalls[0]?.status, 'completed');
  assert.equal(reduced.approvals[0]?.status, 'allowed');
  assert.equal(reduced.diffs[0]?.path, 'README.md');
  assert.equal(reduced.artifacts[0]?.name, 'result.md');
  assert.equal(reduced.context.compactedMessages, 2);
  assert.equal(reduced.context.usedTokens, 10);
  assert.equal(reduced.usage.totalTokens, 15);
  assert.equal(reduced.assistantContent, 'Done');
  assert.strictEqual(replayedDuplicate, reduced);
});

test('todo batch events replace removed items and preserve the runtime order', () => {
  const initial = createCoworkTask('task-1', REQUEST, 1_000, 1);
  const seeded = reduceTaskEvent(initial, {
    id: 'todo-1',
    taskId: 'task-1',
    kind: 'todo',
    timestamp: 2,
    payload: {
      items: [
        { id: 'a', text: 'First', status: 'pending' },
        { id: 'b', text: 'Remove me', status: 'pending' },
        { id: 'c', text: 'Third', status: 'in_progress', detail: 'Keep this detail' },
      ],
    },
  });
  const replaced = reduceTaskEvent(seeded, {
    id: 'todo-2',
    taskId: 'task-1',
    kind: 'todo',
    timestamp: 3,
    payload: {
      items: [
        { id: 'c', text: 'Third', status: 'completed' },
        { id: 'a', text: 'First', status: 'in_progress' },
      ],
    },
  });

  assert.deepEqual(replaced.todos.map((todo) => todo.id), ['c', 'a']);
  assert.equal(replaced.todos[0]?.detail, 'Keep this detail');
  assert.equal(replaced.todos[0]?.status, 'completed');
});

test('snapshot replay preserves cancellation instead of treating done as completion', () => {
  const task = taskFromSnapshot({
    id: 'task-1',
    threadId: 'thread-1',
    state: 'cancelled',
    mode: 'cowork',
    systemPrompt: '',
    policy: 'ask',
    enabledTools: [],
    enabledSkillIds: [],
    createdAt: '2026-09-09T12:00:00.000Z',
    updatedAt: '2026-09-09T12:00:01.000Z',
    events: [
      { id: '1', taskId: 'task-1', kind: 'status', timestamp: 1, payload: { state: 'cancelled' } },
      { id: '2', taskId: 'task-1', kind: 'done', timestamp: 2, payload: { state: 'cancelled' } },
    ],
  }, 1_000);

  assert.equal(task.status, 'cancelled');
});
