/** Ported from routing/heuristics_test.go. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicMatcher } from './heuristics.js';
import type { RequestInfo } from './routing.js';

test('heuristic keyword match', () => {
  const m = new HeuristicMatcher([
    { match: { keywords: ['translate', 'translation'] }, route: 'fast' },
  ]);

  const info: RequestInfo = {
    messages: [{ role: 'user', content: 'Please translate this text to French' }],
    hasTools: false,
  };
  assert.equal(m.match(info), 'fast');
});

test('heuristic keyword no match', () => {
  const m = new HeuristicMatcher([{ match: { keywords: ['translate'] }, route: 'fast' }]);

  const info: RequestInfo = {
    messages: [{ role: 'user', content: 'Write me a poem about the ocean' }],
    hasTools: false,
  };
  assert.equal(m.match(info), '');
});

test('heuristic keyword case insensitive', () => {
  const m = new HeuristicMatcher([{ match: { keywords: ['TRANSLATE'] }, route: 'fast' }]);

  const info: RequestInfo = {
    messages: [{ role: 'user', content: 'translate this' }],
    hasTools: false,
  };
  assert.equal(m.match(info), 'fast');
});

test('heuristic system prompt', () => {
  const m = new HeuristicMatcher([
    { match: { systemPromptContains: 'you are a code assistant' }, route: 'coding' },
  ]);

  const info: RequestInfo = {
    messages: [
      { role: 'system', content: 'You are a code assistant for Python' },
      { role: 'user', content: 'Fix this bug' },
    ],
    hasTools: false,
  };
  assert.equal(m.match(info), 'coding');
});

test('heuristic max tokens', () => {
  const m = new HeuristicMatcher([{ match: { maxTokensLt: 100 }, route: 'fast' }]);

  // matches: max_tokens < 100
  assert.equal(m.match({ messages: [], hasTools: false, maxTokens: 50 }), 'fast');

  // no match: max_tokens >= 100
  assert.equal(m.match({ messages: [], hasTools: false, maxTokens: 200 }), '');

  // no match: max_tokens undefined
  assert.equal(m.match({ messages: [], hasTools: false }), '');
});

test('heuristic message length', () => {
  const m = new HeuristicMatcher([{ match: { messageLengthLt: 20 }, route: 'fast' }]);

  assert.equal(m.match({ messages: [{ role: 'user', content: 'Hi' }], hasTools: false }), 'fast');

  assert.equal(
    m.match({
      messages: [
        { role: 'user', content: 'This is a much longer message that exceeds the limit' },
      ],
      hasTools: false,
    }),
    '',
  );
});

test('heuristic has tools', () => {
  const m = new HeuristicMatcher([{ match: { hasTools: true }, route: 'tool-capable' }]);

  assert.equal(m.match({ messages: [], hasTools: true }), 'tool-capable');
  assert.equal(m.match({ messages: [], hasTools: false }), '');
});

test('heuristic AND logic', () => {
  const m = new HeuristicMatcher([
    { match: { keywords: ['code'], hasTools: true }, route: 'coding-with-tools' },
  ]);

  // both conditions met
  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'Write code for me' }], hasTools: true }),
    'coding-with-tools',
  );

  // only keyword met
  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'Write code for me' }], hasTools: false }),
    '',
  );
});

test('heuristic first match wins', () => {
  const m = new HeuristicMatcher([
    { match: { keywords: ['code'] }, route: 'first' },
    { match: { keywords: ['code'] }, route: 'second' },
  ]);

  assert.equal(m.match({ messages: [{ role: 'user', content: 'Write code' }], hasTools: false }), 'first');
});

test('heuristic no rules', () => {
  const m = new HeuristicMatcher([]);
  assert.equal(m.match({ messages: [{ role: 'user', content: 'hello' }], hasTools: false }), '');
});

test('heuristic word boundary', () => {
  const m = new HeuristicMatcher([{ match: { keywords: ['code'] }, route: 'coding' }]);

  // "code" should NOT match inside "unicode"
  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'explain unicode encoding' }], hasTools: false }),
    '',
  );

  // "code" should match as a standalone word
  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'write some code for me' }], hasTools: false }),
    'coding',
  );
});

test('heuristic multi-word keyword', () => {
  const m = new HeuristicMatcher([{ match: { keywords: ['step by step'] }, route: 'detailed' }]);

  assert.equal(
    m.match({
      messages: [{ role: 'user', content: 'explain step by step how to bake a cake' }],
      hasTools: false,
    }),
    'detailed',
  );

  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'take the next step' }], hasTools: false }),
    '',
  );
});

test('heuristic keywords ignore system prompt', () => {
  const m = new HeuristicMatcher([
    { match: { keywords: ['translate', 'translation'] }, route: 'general' },
  ]);

  // system prompt contains "translation" but user message does not
  assert.equal(
    m.match({
      messages: [
        { role: 'system', content: 'You are a helpful assistant for coding, translation, and more' },
        { role: 'user', content: 'how does gravity work on the moon' },
      ],
      hasTools: false,
    }),
    '',
  );

  // same system prompt, but user message does contain the keyword
  assert.equal(
    m.match({
      messages: [
        { role: 'system', content: 'You are a helpful assistant for coding, translation, and more' },
        { role: 'user', content: 'translate this to French' },
      ],
      hasTools: false,
    }),
    'general',
  );
});

test('heuristic exclude', () => {
  const m = new HeuristicMatcher([
    {
      match: { keywords: ['code'], exclude: ['code fences', 'code block'] },
      route: 'coding',
    },
  ]);

  // "code" present but "code fences" triggers exclusion
  assert.equal(
    m.match({
      messages: [{ role: 'user', content: 'without any markdown code fences, generate a title' }],
      hasTools: false,
    }),
    '',
  );

  // "code" present, no exclusion phrase
  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'write some code for me' }], hasTools: false }),
    'coding',
  );

  // "code block" exclusion
  assert.equal(
    m.match({
      messages: [{ role: 'user', content: 'do not use a code block in your response' }],
      hasTools: false,
    }),
    '',
  );
});

test('heuristic exclude empty', () => {
  // no exclusions configured, keywords work normally
  const m = new HeuristicMatcher([{ match: { keywords: ['code'] }, route: 'coding' }]);

  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'write code for me' }], hasTools: false }),
    'coding',
  );
});

test('heuristic special char keyword', () => {
  const m = new HeuristicMatcher([{ match: { keywords: ['c++'] }, route: 'coding' }]);

  assert.equal(
    m.match({ messages: [{ role: 'user', content: 'write a c++ program' }], hasTools: false }),
    'coding',
  );
});
