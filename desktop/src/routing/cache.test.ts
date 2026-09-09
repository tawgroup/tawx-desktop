/** Ported from routing/cache_test.go. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache, hashKey } from './cache.js';

test('cache get/put', () => {
  const c = new LRUCache<string>(10, 60 * 60 * 1000);

  c.put('key1', 'value1');
  const got = c.get('key1');
  assert.equal(got.ok, true);
  assert.equal(got.value, 'value1');

  assert.equal(c.get('missing').ok, false);
});

test('cache LRU eviction', () => {
  const c = new LRUCache<number>(3, 60 * 60 * 1000);

  c.put('a', 1);
  c.put('b', 2);
  c.put('c', 3);

  // access "a" to make it most recently used
  c.get('a');

  // adding "d" should evict "b" (least recently used)
  c.put('d', 4);

  assert.equal(c.get('b').ok, false, "expected 'b' to be evicted");

  const a = c.get('a');
  assert.equal(a.ok, true, "expected 'a' to still be present");
  assert.equal(a.value, 1);

  const cc = c.get('c');
  assert.equal(cc.ok, true, "expected 'c' to still be present");
  assert.equal(cc.value, 3);

  const d = c.get('d');
  assert.equal(d.ok, true, "expected 'd' to still be present");
  assert.equal(d.value, 4);
});

test('cache TTL expiration', async () => {
  const c = new LRUCache<string>(10, 50);

  c.put('key', 'value');
  const immediate = c.get('key');
  assert.equal(immediate.ok, true);
  assert.equal(immediate.value, 'value');

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(c.get('key').ok, false, 'expected miss after TTL expiration');
});

test('cache update', () => {
  const c = new LRUCache<string>(10, 60 * 60 * 1000);

  c.put('key', 'v1');
  c.put('key', 'v2');

  const got = c.get('key');
  assert.equal(got.ok, true);
  assert.equal(got.value, 'v2');
});

test('hashKey deterministic', () => {
  const h1 = hashKey('hello world');
  const h2 = hashKey('hello world');
  assert.equal(h1, h2, 'hashKey not deterministic');

  const h3 = hashKey('different input');
  assert.notEqual(h1, h3, 'hashKey collision on different inputs');
});
