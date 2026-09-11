import assert from 'node:assert/strict';
import test from 'node:test';
import { dequeue, shouldFlushQueue } from '../src/store/useChats.ts';
import type { QueuedMessage } from '../src/types.ts';

const entry = (id: string, text = id): QueuedMessage => ({ id, text, attachments: [] });

test('the queue is sent oldest first', () => {
  const { next, rest } = dequeue([entry('q-1'), entry('q-2')]);
  assert.equal(next?.id, 'q-1');
  assert.deepEqual(rest.map((item) => item.id), ['q-2']);
});

test('an empty queue has nothing to send', () => {
  assert.deepEqual(dequeue([]), { next: null, rest: [] });
});

test('dequeue leaves the queue it was given alone', () => {
  const queue = [entry('q-1'), entry('q-2')];
  dequeue(queue);
  assert.deepEqual(queue.map((item) => item.id), ['q-1', 'q-2']);
});

/**
 * Stop and Steer both abort the run, and the queue is what tells them apart:
 * stopping is "wait, let me rewrite that", steering is "send it now".
 */
test('an answer that finished on its own hands over to the queue', () => {
  assert.equal(shouldFlushQueue({ aborted: false, failed: false, steered: false }), true);
});

test('stopping an answer leaves the queue where it is', () => {
  assert.equal(shouldFlushQueue({ aborted: true, failed: false, steered: false }), false);
});

test('a failed answer holds the queue rather than repeating the error', () => {
  assert.equal(shouldFlushQueue({ aborted: false, failed: true, steered: false }), false);
});

test('steering sends the queue even though it aborted the answer', () => {
  assert.equal(shouldFlushQueue({ aborted: true, failed: false, steered: true }), true);
});
