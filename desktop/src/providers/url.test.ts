import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './errors.js';
import { adapterBaseUrl, assertProviderUrl, isLoopbackHost } from './url.js';

/**
 * The mismatch this reconciles produced `/v1/v1/chat/completions` against every
 * migrated provider: the Settings field asks for a URL "including /v1", the
 * adapters append `/v1/...` themselves.
 */
test('adapterBaseUrl strips one trailing /v1 and accepts either form', () => {
  assert.equal(adapterBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com');
  assert.equal(adapterBaseUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai');
  assert.equal(adapterBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434');

  // A user who omits it is equally correct.
  assert.equal(adapterBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com');

  // A URL normalized by `new URL().toString()` gains a trailing slash.
  assert.equal(adapterBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(adapterBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com');

  // Only one segment, and only at the end.
  assert.equal(adapterBaseUrl('https://api.example.com/v1/v1'), 'https://api.example.com/v1');
  assert.equal(adapterBaseUrl('https://api.example.com/v1/beta'), 'https://api.example.com/v1/beta');

  // A path that merely ends in those characters is not a version segment.
  assert.equal(adapterBaseUrl('https://api.example.com/openv1'), 'https://api.example.com/openv1');
});

test('assertProviderUrl demands HTTPS unless the host is loopback', () => {
  assert.equal(assertProviderUrl('https://api.deepseek.com/v1').hostname, 'api.deepseek.com');
  assert.equal(assertProviderUrl('http://localhost:11434/v1').port, '11434');
  assert.equal(assertProviderUrl('http://127.0.0.1:1234/v1').port, '1234');

  assert.throws(() => assertProviderUrl('http://api.example.com/v1'), ApiError);
  assert.throws(() => assertProviderUrl('not-a-url'), ApiError);
  assert.throws(() => assertProviderUrl(''), ApiError);
  // Credentials in the URL would reach the upstream as an unintended header.
  assert.throws(() => assertProviderUrl('https://user:pass@api.example.com/v1'), ApiError);
  assert.throws(() => assertProviderUrl('https://api.example.com/v1#frag'), ApiError);
});

test('isLoopbackHost matches what Go treats as loopback', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['example.com', '10.0.0.1', '128.0.0.1', '', '0.0.0.0']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
