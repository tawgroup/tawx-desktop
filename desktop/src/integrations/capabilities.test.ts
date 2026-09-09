import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityDeniedError,
  CapabilityRegistry,
  type CapabilityAdapter,
  type CapabilityApprovalRequest,
  type CapabilityAuditEvent,
  type CapabilityContext,
} from './capabilities.js';

function context(overrides: Partial<CapabilityContext> = {}): { value: CapabilityContext; events: CapabilityAuditEvent[] } {
  const events: CapabilityAuditEvent[] = [];
  return {
    events,
    value: {
      taskId: 'task-1',
      workspace: '/project',
      policy: 'allow',
      enabledTools: ['sample'],
      requestApproval: async () => 'allow_once',
      audit: (event) => { events.push(event); },
      ...overrides,
    },
  };
}

function sampleAdapter(invoke: () => Promise<unknown>, risk: 'read' | 'write' | 'external' = 'write'): CapabilityAdapter {
  return {
    id: 'sample',
    status: async () => ({ id: 'sample', name: 'Sample', available: true, configured: true, detail: 'Ready', toolCount: 1 }),
    tools: async () => [{
      definition: { type: 'function', function: { name: 'sample_write', parameters: { type: 'object' } } },
      risk,
      approvalDetail: () => 'Change a sample',
      invoke,
    }],
  };
}

test('plan policy denies mutating capabilities before invocation', async () => {
  let invoked = false;
  const registry = new CapabilityRegistry();
  registry.register(sampleAdapter(async () => { invoked = true; }));
  const { value, events } = context({ policy: 'plan' });

  await assert.rejects(() => registry.invoke('sample_write', {}, value), CapabilityDeniedError);
  assert.equal(invoked, false);
  assert.deepEqual(events.map((event) => event.phase), ['requested', 'denied']);
});

test('alwaysApprove requests consent even in allow mode and redacts audit payloads', async () => {
  const registry = new CapabilityRegistry();
  const adapter = sampleAdapter(async () => ({ apiKey: 'result-secret', ok: true }));
  const tools = await adapter.tools();
  if (!tools[0]) throw new Error('missing test tool');
  tools[0].alwaysApprove = true;
  tools[0].auditInput = (input) => input;
  adapter.tools = async () => tools;
  registry.register(adapter);
  let approvals = 0;
  const { value, events } = context({
    requestApproval: async () => { approvals += 1; return 'allow_once'; },
  });

  const result = await registry.invoke('sample_write', { token: 'input-secret' }, value);

  assert.deepEqual(result, { apiKey: 'result-secret', ok: true });
  assert.equal(approvals, 1);
  assert.equal(JSON.stringify(events).includes('input-secret'), false);
  assert.equal(JSON.stringify(events).includes('result-secret'), false);
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
});

test('approval input shows ordinary content, redacts tokens, and scopes signatures to exact actions', async () => {
  const registry = new CapabilityRegistry();
  const adapter = sampleAdapter(async () => ({ ok: true }));
  const tools = await adapter.tools();
  if (!tools[0]) throw new Error('missing test tool');
  tools[0].alwaysApprove = true;
  tools[0].auditInput = (input) => {
    const record = input as Record<string, unknown>;
    return { path: record.path, content: '[REDACTED]' };
  };
  adapter.tools = async () => tools;
  registry.register(adapter);
  const approvals: CapabilityApprovalRequest[] = [];
  const { value } = context({
    requestApproval: async (request) => {
      approvals.push(request);
      return 'allow_once';
    },
  });

  await registry.invoke('sample_write', { path: 'result.txt', content: 'first proposal', token: 'token-one' }, value);
  await registry.invoke('sample_write', { path: 'result.txt', content: 'second proposal', token: 'token-two' }, value);

  assert.equal(approvals.length, 2);
  assert.notEqual(approvals[0]?.signature, approvals[1]?.signature);
  assert.deepEqual(approvals[0]?.input, {
    path: 'result.txt',
    content: 'first proposal',
    token: '[REDACTED]',
  });
  assert.deepEqual(approvals[0]?.risk, {
    level: 'write',
    summary: 'Change a sample',
    reasons: ['Creates or changes files in the selected project.', 'This integration requires explicit approval even in allow mode.'],
  });
  assert.equal(JSON.stringify(approvals).includes('first proposal'), true);
  assert.equal(JSON.stringify(approvals).includes('token-one'), false);
  assert.equal(JSON.stringify(approvals).includes('token-two'), false);
});

test('disabled task tools are rejected', async () => {
  const registry = new CapabilityRegistry();
  registry.register(sampleAdapter(async () => 'not reached', 'read'));
  const { value } = context({ enabledTools: [] });

  await assert.rejects(() => registry.invoke('sample_write', {}, value), /not enabled/);
});
