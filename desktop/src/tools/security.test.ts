import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandSafetyError,
  commandEnvironment,
  parseCommand,
  redactText,
  redactValue,
} from './security.js';

test('redacts structured and textual credential forms', () => {
  const source = [
    'TOKEN=plain-secret',
    '"apiKey": "custom value with spaces"',
    "password='quoted secret'",
    'Authorization: Bearer abcdefghijklmnop',
    'https://user:password@example.test/path',
    'custom+dev://custom-user:custom-secret@example.test/resource',
    'sk-abcdefghijklmnopqrstuv',
  ].join('\n');

  const redacted = redactText(source);
  assert.doesNotMatch(redacted, /plain-secret|custom value|quoted secret|abcdefghijklmnop|user:password|custom-user|custom-secret/);
  assert.match(redacted, /\[REDACTED\]/);

  const structured = redactValue({
    apiKey: 'arbitrary-value',
    nested: { accessToken: 'another-value', safe: 'visible' },
  });
  assert.deepEqual(structured, {
    apiKey: '[REDACTED]',
    nested: { accessToken: '[REDACTED]', safe: 'visible' },
  });
});

test('redaction remains bounded for large credential-free output', () => {
  const source = 'x'.repeat(1_000_001);
  const startedAt = Date.now();
  assert.equal(redactText(source), source);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 2_000, `large redaction took ${elapsedMs}ms`);
});

test('parses quoted arguments but rejects shell composition and direct git', () => {
  assert.deepEqual(parseCommand("printf 'hello world'"), {
    executable: 'printf',
    args: ['hello world'],
  });
  assert.throws(() => parseCommand('printf safe && cat secret'), CommandSafetyError);
  assert.throws(() => parseCommand('echo $(cat secret)'), CommandSafetyError);
  assert.throws(() => parseCommand('git reset --hard'), /guarded git tools/);
  assert.throws(() => parseCommand("node -e 'process.exit()'"), /inline node programs/);
});

test('child command environments omit inherited credentials and injection hooks', () => {
  const previousToken = process.env.COWORK_TEST_TOKEN;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  try {
    process.env.COWORK_TEST_TOKEN = 'must-not-leak';
    process.env.NODE_OPTIONS = '--require=/tmp/inject.js';
    const environment = commandEnvironment('/workspace');
    assert.equal(environment.COWORK_TEST_TOKEN, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.PWD, '/workspace');
  } finally {
    if (previousToken === undefined) delete process.env.COWORK_TEST_TOKEN;
    else process.env.COWORK_TEST_TOKEN = previousToken;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
});
