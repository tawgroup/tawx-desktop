/** Ported from routing/classifier_test.go. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ClassifierMatcher } from './classifier.js';
import type { ClassifierConfig, RouteConfig } from './config.js';
import type { RequestInfo } from './routing.js';
import { startTestServer, readBody } from '../test-support/server.js';
import type { ChatCompletionResponse } from '../providers/types.js';

function jsonHandler(resp: ChatCompletionResponse) {
  return (_req: unknown, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
  };
}

test('classifier matcher success', async () => {
  const server = await startTestServer(
    jsonHandler({
      id: '', object: '', created: 0, model: '',
      choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '{"category": "coding", "confidence": 0.95}' } }],
    }),
  );
  try {
    const cfg: ClassifierConfig = { enabled: true, model: 'llama3', confidenceThreshold: 0.5 };
    const routes: RouteConfig[] = [
      { name: 'coding', model: 'gpt-4', description: 'code generation and debugging' },
      { name: 'creative', model: 'claude-3', description: 'creative writing' },
    ];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: '' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'fix this bug in my code' }], hasTools: false };
    const { route, confidence } = await cm.classify(info);
    assert.equal(route, 'coding');
    assert.equal(confidence, 0.95);
  } finally {
    await server.close();
  }
});

test('classifier matcher custom prompt', () => {
  const cfg: ClassifierConfig = { enabled: false, model: '', confidenceThreshold: 0, prompt: 'Choose the cheapest capable route.' };
  const cm = new ClassifierMatcher(cfg, [{ name: 'fast', model: '', description: 'simple requests' }], {
    baseUrl: '',
    apiKey: '',
  });

  const prompt = cm.buildPrompt({ messages: [{ role: 'user', content: 'hello' }], hasTools: false });
  assert.ok(prompt.startsWith(`${cfg.prompt}\n\nCategories:`), `custom prompt not used: ${prompt}`);
  assert.ok(prompt.includes('- fast: simple requests'), `generated classification context missing: ${prompt}`);
  assert.ok(prompt.includes('User request:\nhello'), `generated classification context missing: ${prompt}`);
});

test('classifier matcher markdown wrapped', async () => {
  const server = await startTestServer(
    jsonHandler({
      id: '', object: '', created: 0, model: '',
      choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '```json\n{"category": "creative", "confidence": 0.8}\n```' } }],
    }),
  );
  try {
    const cfg: ClassifierConfig = { enabled: true, model: 'llama3', confidenceThreshold: 0 };
    const routes: RouteConfig[] = [{ name: 'creative', model: 'claude-3', description: 'creative writing' }];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: '' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'write a poem' }], hasTools: false };
    const { route } = await cm.classify(info);
    assert.equal(route, 'creative');
  } finally {
    await server.close();
  }
});

test('classifier matcher unknown category', async () => {
  const server = await startTestServer(
    jsonHandler({
      id: '', object: '', created: 0, model: '',
      choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '{"category": "unknown_route", "confidence": 0.9}' } }],
    }),
  );
  try {
    const cfg: ClassifierConfig = { enabled: true, model: 'llama3', confidenceThreshold: 0 };
    const routes: RouteConfig[] = [{ name: 'coding', model: 'gpt-4', description: 'coding' }];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: '' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'test' }], hasTools: false };
    await assert.rejects(() => cm.classify(info));
  } finally {
    await server.close();
  }
});

test('classifier matcher server error', async () => {
  const server = await startTestServer((_req, res) => {
    res.writeHead(500);
    res.end('server error');
  });
  try {
    const cfg: ClassifierConfig = { enabled: true, model: 'llama3', confidenceThreshold: 0 };
    const routes: RouteConfig[] = [{ name: 'coding', model: 'gpt-4' }];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: '' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'test' }], hasTools: false };
    await assert.rejects(() => cm.classify(info));
  } finally {
    await server.close();
  }
});

test('classifier matcher case insensitive category', async () => {
  const server = await startTestServer(
    jsonHandler({
      id: '', object: '', created: 0, model: '',
      choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '{"category": "Coding", "confidence": 0.9}' } }],
    }),
  );
  try {
    const cfg: ClassifierConfig = { enabled: true, model: 'llama3', confidenceThreshold: 0 };
    const routes: RouteConfig[] = [{ name: 'coding', model: 'gpt-4', description: 'coding' }];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: '' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'test' }], hasTools: false };
    const { route } = await cm.classify(info);
    assert.equal(route, 'coding');
  } finally {
    await server.close();
  }
});

test('classifier matcher cache', async () => {
  let callCount = 0;
  const server = await startTestServer((_req, res) => {
    callCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: '', object: '', created: 0, model: '',
      choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '{"category": "coding", "confidence": 0.95}' } }],
    }));
  });
  try {
    const cfg: ClassifierConfig = {
      enabled: true,
      model: 'llama3',
      confidenceThreshold: 0.5,
      cacheResults: true,
      cacheTtl: 3600,
      cacheSize: 100,
    };
    const routes: RouteConfig[] = [{ name: 'coding', model: 'gpt-4', description: 'code generation' }];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: '' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'fix this bug in my code' }], hasTools: false };

    // first call: should hit the server
    callCount = 0;
    let { route, confidence } = await cm.classify(info);
    assert.equal(route, 'coding');
    assert.equal(confidence, 0.95);
    assert.equal(callCount, 1);

    // second call with same input: should hit cache
    callCount = 0;
    ({ route, confidence } = await cm.classify(info));
    assert.equal(route, 'coding');
    assert.equal(confidence, 0.95);
    assert.equal(callCount, 0, 'expected 0 server calls (cache hit)');
  } finally {
    await server.close();
  }
});

test('classifier matcher with auth', async () => {
  let gotAuth = '';
  const server = await startTestServer(async (req, res) => {
    gotAuth = req.headers.authorization ?? '';
    await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: '', object: '', created: 0, model: '',
      choices: [{ index: 0, finish_reason: null, message: { role: 'assistant', content: '{"category": "coding", "confidence": 0.9}' } }],
    }));
  });
  try {
    const cfg: ClassifierConfig = { enabled: true, model: 'gpt-4', confidenceThreshold: 0 };
    const routes: RouteConfig[] = [{ name: 'coding', model: 'gpt-4', description: 'coding' }];
    const cm = new ClassifierMatcher(cfg, routes, { baseUrl: server.url, apiKey: 'sk-test' });

    const info: RequestInfo = { messages: [{ role: 'user', content: 'test' }], hasTools: false };
    await cm.classify(info);
    assert.equal(gotAuth, 'Bearer sk-test');
  } finally {
    await server.close();
  }
});
