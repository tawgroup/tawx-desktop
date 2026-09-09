import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SchedulerRuntime } from './runtime.js';
import type { AgentTaskRequest } from '../agent/types.js';
import type { CreateScheduleInput, ScheduledTaskSnapshot, SchedulerClock } from './types.js';

class ManualClock implements SchedulerClock {
  constructor(private current: Date) {}
  private readonly handles = new Set<unknown>();

  now(): Date {
    return new Date(this.current);
  }

  set(date: string): void {
    this.current = new Date(date);
  }

  setTimeout(): unknown {
    const handle = Symbol('timer');
    this.handles.add(handle);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.handles.delete(handle);
  }

  get activeTimerCount(): number {
    return this.handles.size;
  }
}

const TASK: ScheduledTaskSnapshot = {
  threadId: 'thread-approved',
  mode: 'cowork',
  messages: [{ role: 'user', content: 'Inspect the approved workspace' }],
  systemPrompt: 'Use only evidence from the workspace.',
  workspace: { path: '/tmp/approved-workspace', name: 'approved-workspace' },
  policy: 'plan',
  enabledTools: ['read_file', 'list_directory'],
  enabledSkillIds: [],
  model: 'approved-model',
};

function scheduleInput(missedRun: 'skip' | 'run_once'): CreateScheduleInput {
  return {
    name: 'Persistent review',
    trigger: { kind: 'interval', everyMinutes: 60, anchorAt: '2026-09-09T10:00:00.000Z' },
    missedRun,
    task: TASK,
    approved: true,
  };
}

test('schedules and approval snapshots survive reopening the runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-scheduler-'));
  const clock = new ManualClock(new Date('2026-09-09T09:00:00.000Z'));
  try {
    const first = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: { dispatch: async () => ({ id: 'unused' }) },
      idFactory: () => 'schedule-1',
    });
    const created = await first.create(scheduleInput('run_once'));
    await first.stop();

    const reopened = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: { dispatch: async () => ({ id: 'unused' }) },
    });
    const [stored] = await reopened.list();
    assert.equal(stored?.id, created.id);
    assert.deepEqual(stored?.task, TASK);
    assert.deepEqual(stored?.approval, {
      approvedAt: '2026-09-09T09:00:00.000Z',
      threadId: TASK.threadId,
      workspace: TASK.workspace,
      policy: TASK.policy,
      enabledTools: TASK.enabledTools,
      enabledSkillIds: TASK.enabledSkillIds,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('credentials are redacted before a schedule snapshot is persisted or dispatched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-scheduler-'));
  const clock = new ManualClock(new Date('2026-09-09T09:00:00.000Z'));
  const sensitiveTask: ScheduledTaskSnapshot = {
    ...TASK,
    messages: [
      { role: 'user', content: 'Review config with api_key=\"plain-secret\"' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{\"authorization\":\"Bearer abcdefghijklmnop\"}',
          },
        }],
      },
    ],
    systemPrompt: 'password=system-secret',
  };
  let dispatched: AgentTaskRequest | undefined;
  try {
    const first = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: { dispatch: async () => ({ id: 'unused' }) },
      idFactory: () => 'schedule-sensitive',
    });
    await first.create({ ...scheduleInput('run_once'), task: sensitiveTask });
    await first.stop();

    const persisted = await readFile(join(directory, 'schedules.json'), 'utf8');
    assert.doesNotMatch(persisted, /plain-secret|abcdefghijklmnop|system-secret/);
    assert.match(persisted, /\[REDACTED\]/);

    clock.set('2026-09-09T10:30:00.000Z');
    const reopened = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: {
        dispatch: async (request) => {
          dispatched = request;
          return { id: 'redacted-task' };
        },
      },
    });
    await reopened.start();
    const dispatchedJson = JSON.stringify(dispatched);
    assert.ok(dispatchedJson);
    assert.doesNotMatch(dispatchedJson, /plain-secret|abcdefghijklmnop|system-secret/);
    assert.match(dispatchedJson, /\[REDACTED\]/);
    await reopened.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('run_once coalesces missed occurrences and dispatches the stored task snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-scheduler-'));
  const clock = new ManualClock(new Date('2026-09-09T09:00:00.000Z'));
  const dispatched: AgentTaskRequest[] = [];
  try {
    const first = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: { dispatch: async () => ({ id: 'unused' }) },
      idFactory: () => 'schedule-1',
    });
    await first.create(scheduleInput('run_once'));
    await first.stop();

    clock.set('2026-09-09T12:30:00.000Z');
    let nextId = 0;
    const reopened = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: {
        dispatch: async (request) => {
          dispatched.push(request);
          return { id: 'task-42' };
        },
      },
      idFactory: () => `execution-${nextId += 1}`,
    });
    await reopened.start();

    assert.deepEqual(dispatched, [TASK]);
    const [execution] = await reopened.history('schedule-1');
    assert.equal(execution?.scheduledFor, '2026-09-09T10:00:00.000Z');
    assert.equal(execution?.status, 'dispatched');
    assert.equal(execution?.taskId, 'task-42');
    assert.equal((await reopened.get('schedule-1')).nextRunAt, '2026-09-09T13:00:00.000Z');
    await reopened.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('skip advances a missed schedule without creating history or dispatching a task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-scheduler-'));
  const clock = new ManualClock(new Date('2026-09-09T09:00:00.000Z'));
  let dispatchCount = 0;
  try {
    const first = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: { dispatch: async () => ({ id: 'unused' }) },
      idFactory: () => 'schedule-1',
    });
    await first.create(scheduleInput('skip'));
    await first.stop();

    clock.set('2026-09-09T12:30:00.000Z');
    const reopened = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: {
        dispatch: async () => {
          dispatchCount += 1;
          return { id: 'unexpected' };
        },
      },
    });
    await reopened.start();

    assert.equal(dispatchCount, 0);
    assert.deepEqual(await reopened.history('schedule-1'), []);
    assert.equal((await reopened.get('schedule-1')).nextRunAt, '2026-09-09T13:00:00.000Z');
    await reopened.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('edits require renewed approval while disabled and deleted schedules stay inert across the app lifetime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-scheduler-'));
  const clock = new ManualClock(new Date('2026-09-09T09:00:00.000Z'));
  try {
    const runtime = await SchedulerRuntime.open({
      directory,
      clock,
      dispatcher: { dispatch: async () => ({ id: 'unused' }) },
      idFactory: () => 'schedule-1',
    });
    await runtime.create(scheduleInput('run_once'));
    await assert.rejects(
      () => runtime.update('schedule-1', { task: { ...TASK, policy: 'allow' } }),
      /approved must be true/,
    );
    clock.set('2026-09-09T09:05:00.000Z');
    const updated = await runtime.update('schedule-1', {
      task: { ...TASK, policy: 'allow' },
      approved: true,
    });
    assert.equal(updated.approval.policy, 'allow');
    assert.equal(updated.approval.approvedAt, clock.now().toISOString());
    await runtime.start();
    await runtime.start();
    assert.equal(clock.activeTimerCount, 1);

    const disabled = await runtime.setEnabled('schedule-1', false);
    assert.equal(disabled.nextRunAt, null);
    assert.equal(clock.activeTimerCount, 0);

    await runtime.remove('schedule-1');
    assert.deepEqual(await runtime.list(), []);
    await runtime.stop();
    await runtime.stop();
    assert.equal(clock.activeTimerCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
