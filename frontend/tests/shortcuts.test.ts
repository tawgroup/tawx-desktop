import assert from 'node:assert/strict';
import test from 'node:test';
import { commandForKeyboardEvent } from '../src/lib/shortcuts.ts';

const key = (
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {},
) => commandForKeyboardEvent({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

test('maps the researched app shortcuts on Command or Control', () => {
  assert.equal(key('n', { metaKey: true }), 'new-chat');
  assert.equal(key('[', { ctrlKey: true }), 'previous-chat');
  assert.equal(key(']', { metaKey: true }), 'next-chat');
  assert.equal(key('1', { metaKey: true }), 'mode-chat');
  assert.equal(key('2', { metaKey: true }), 'mode-cowork');
  assert.equal(key('3', { metaKey: true }), 'mode-code');
  assert.equal(key('k', { metaKey: true, shiftKey: true }), 'focus-composer');
  assert.equal(key(',', { metaKey: true }), 'open-settings');
  assert.equal(key('x', { metaKey: true, altKey: true }), 'toggle-context');
  assert.equal(key('s', { metaKey: true, altKey: true }), 'toggle-sidebar');
  assert.equal(key('k', { metaKey: true }), 'search-chats');
  assert.equal(key('.', { metaKey: true }), 'stop-generation');
});

test('leaves text editing and reserved combinations untouched', () => {
  assert.equal(key('n'), undefined);
  assert.equal(key('f', { metaKey: true }), undefined);
  assert.equal(key(' ', { metaKey: true }), undefined);
  assert.equal(key('i', { metaKey: true, altKey: true }), undefined);
  assert.equal(key('k', { metaKey: true, altKey: true, shiftKey: true }), undefined);
});
