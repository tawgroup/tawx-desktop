import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAdapter, type BrowserInteraction, type BrowserSession } from './browser.js';
import {
  CapabilityRegistry,
  type CapabilityApprovalRequest,
  type CapabilityAuditEvent,
  type CapabilityContext,
} from './capabilities.js';

function fakeSession(actions: string[]): BrowserSession {
  const inspection = {
    url: 'https://example.com/',
    title: 'Example',
    text: 'Visible page',
    truncated: false,
    elements: [{ selector: '#submit', role: 'button', name: 'Submit', disabled: false }],
  };
  return {
    navigate: async (url) => { actions.push(`navigate:${url}`); return { url, title: 'Example' }; },
    inspect: async () => { actions.push('inspect'); return inspection; },
    interact: async (action: BrowserInteraction) => { actions.push(`${action.action}:${action.selector}`); return inspection; },
    close: () => { actions.push('close'); },
  };
}

function taskContext(events: CapabilityAuditEvent[], approve: CapabilityContext['requestApproval']): CapabilityContext {
  return {
    taskId: 'browser-task',
    workspace: '/project',
    policy: 'allow',
    enabledTools: ['browser'],
    requestApproval: approve,
    audit: (event) => { events.push(event); },
  };
}

test('browser navigation requires explicit approval in allow mode', async () => {
  const actions: string[] = [];
  const events: CapabilityAuditEvent[] = [];
  const adapter = new BrowserAdapter(() => fakeSession(actions));
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  let approvals = 0;

  const result = await registry.invoke('browser_navigate', { url: 'https://example.com/path?token=secret' }, taskContext(events, async () => {
    approvals += 1;
    return 'allow_once';
  }));

  assert.deepEqual(result, { url: 'https://example.com/path?token=secret', title: 'Example' });
  assert.equal(approvals, 1);
  assert.deepEqual(actions, ['navigate:https://example.com/path?token=secret']);
  assert.equal(JSON.stringify(events).includes('token=secret'), false);
});

test('browser approval exposes ordinary typed values before execution', async () => {
  const adapter = new BrowserAdapter(() => fakeSession([]));
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  let approval: CapabilityApprovalRequest | undefined;

  await registry.invoke(
    'browser_interact',
    { action: 'type', selector: '#title', value: 'Release notes' },
    taskContext([], async (request) => {
      approval = request;
      return 'allow_once';
    }),
  );

  assert.deepEqual(approval?.input, {
    action: 'type',
    selector: '#title',
    value: 'Release notes',
  });
});

test('browser rejects arbitrary protocols and scripts', async () => {
  const adapter = new BrowserAdapter(() => fakeSession([]));
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  const events: CapabilityAuditEvent[] = [];
  const context = taskContext(events, async () => 'allow_once');

  await assert.rejects(() => registry.invoke('browser_navigate', { url: 'file:///etc/passwd' }, context), /HTTP and HTTPS/);
  await assert.rejects(() => registry.invoke('browser_interact', { action: 'evaluate', selector: 'body', value: 'alert(1)' }, context), /action must be/);
});

test('browser denial prevents session creation', async () => {
  let created = false;
  const adapter = new BrowserAdapter(() => {
    created = true;
    return fakeSession([]);
  });
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  const events: CapabilityAuditEvent[] = [];

  await assert.rejects(
    () => registry.invoke('browser_inspect', {}, taskContext(events, async () => 'deny')),
    /user denied/,
  );
  assert.equal(created, false);
});

test('browser sessions are isolated per task', async () => {
  const sessions: string[][] = [];
  const adapter = new BrowserAdapter(() => {
    const actions: string[] = [];
    sessions.push(actions);
    return fakeSession(actions);
  });
  const registry = new CapabilityRegistry();
  registry.register(adapter);
  const first = taskContext([], async () => 'allow_once');
  first.taskId = 'task-a';
  const second = taskContext([], async () => 'allow_once');
  second.taskId = 'task-b';

  await registry.invoke('browser_navigate', { url: 'https://one.example/' }, first);
  await registry.invoke('browser_navigate', { url: 'https://two.example/' }, second);

  assert.deepEqual(sessions, [
    ['navigate:https://one.example/'],
    ['navigate:https://two.example/'],
  ]);
  await adapter.close();
});
