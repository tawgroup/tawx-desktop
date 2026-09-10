import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleStreamState } from '../src/store/useChats.ts';
import type { CoworkTask, Message } from '../src/types.ts';

function message(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 'chat-1',
    role: 'assistant',
    content: '',
    createdAt: 0,
    ...extra,
  } as Message;
}

const task = (status: CoworkTask['status'], id = 'task-1') => ({ id, status }) as CoworkTask;

/**
 * `streaming` and `streamingId` describe the chat on screen. They used to be
 * assigned by whichever completion ran last, which is why switching chats had
 * to abort the running one: leaving it alive would have left the flags
 * describing a chat the reader was no longer looking at.
 */
test('a chat with an answer in flight reads as streaming', () => {
  assert.deepEqual(visibleStreamState(message('m-1'), null, []), {
    streaming: true,
    streamingId: 'm-1',
  });
});

test('a chat with nothing in flight reads as idle', () => {
  assert.deepEqual(visibleStreamState(undefined, null, [message('m-1')]), {
    streaming: false,
    streamingId: null,
  });
});

test('an active task streams, a finished one does not', () => {
  const messages = [message('m-1', { taskId: 'task-1' })];

  for (const status of ['planning', 'running', 'waiting_approval'] as const) {
    assert.deepEqual(
      visibleStreamState(undefined, task(status), messages),
      { streaming: true, streamingId: 'm-1' },
      status,
    );
  }

  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    assert.deepEqual(
      visibleStreamState(undefined, task(status), messages),
      { streaming: false, streamingId: null },
      status,
    );
  }
});

test('a completion in flight takes precedence over a task', () => {
  // Chat mode writes a completion; the task belongs to Cowork or Code. If both
  // are somehow present, the answer being written is the one on screen.
  assert.deepEqual(
    visibleStreamState(message('m-live'), task('running'), [message('m-1', { taskId: 'task-1' })]),
    { streaming: true, streamingId: 'm-live' },
  );
});

test('an active task with no message yet streams without a target', () => {
  assert.deepEqual(visibleStreamState(undefined, task('running'), []), {
    streaming: true,
    streamingId: null,
  });
});
