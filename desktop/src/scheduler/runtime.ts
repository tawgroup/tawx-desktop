import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { redactText, redactValue } from '../tools/security.js';
import { nextRunAfter, validateTrigger } from './next-run.js';
import { ScheduleStore } from './store.js';
import type {
  CreateScheduleInput,
  PersistedSchedulerState,
  ScheduleApprovalSnapshot,
  ScheduleExecution,
  ScheduleRecord,
  ScheduleTrigger,
  ScheduledTaskSnapshot,
  SchedulerClock,
  TaskDispatcher,
  UpdateScheduleInput,
} from './types.js';

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const HISTORY_LIMIT = 100;
const MISSED_GRACE_MS = 60_000;

const systemClock: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class SchedulerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerValidationError';
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule '${id}' was not found`);
    this.name = 'ScheduleNotFoundError';
  }
}

export interface SchedulerRuntimeOptions {
  directory: string;
  dispatcher: TaskDispatcher;
  clock?: SchedulerClock;
  idFactory?: () => string;
  onError?: (error: unknown) => void;
}

interface PendingDispatch {
  scheduleId: string;
  executionId: string;
  task: ScheduledTaskSnapshot;
}

export class SchedulerRuntime {
  private state: PersistedSchedulerState;
  private readonly store: ScheduleStore;
  private readonly dispatcher: TaskDispatcher;
  private readonly clock: SchedulerClock;
  private readonly idFactory: () => string;
  private readonly onError?: (error: unknown) => void;
  private timer: unknown;
  private started = false;
  private lock: Promise<void> = Promise.resolve();

  private constructor(options: SchedulerRuntimeOptions, state: PersistedSchedulerState) {
    this.store = new ScheduleStore(options.directory);
    this.dispatcher = options.dispatcher;
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
    this.onError = options.onError;
    this.state = state;
    validatePersistedState(state);
  }

  static async open(options: SchedulerRuntimeOptions): Promise<SchedulerRuntime> {
    const store = new ScheduleStore(options.directory);
    const state = await store.load();
    return new SchedulerRuntime(options, state);
  }

  async start(): Promise<void> {
    const pending = await this.exclusive(async () => {
      if (this.started) return [];
      const now = this.clock.now();
      const draft = structuredClone(this.state);
      let changed = markInterruptedExecutions(draft, now);
      const dispatches: PendingDispatch[] = [];

      for (const schedule of draft.schedules) {
        if (!schedule.enabled || schedule.nextRunAt === null || Date.parse(schedule.nextRunAt) > now.getTime()) continue;
        changed = true;
        if (schedule.missedRun === 'run_once') {
          dispatches.push(beginExecution(draft, schedule, schedule.nextRunAt, now, this.idFactory));
        } else {
          advanceSchedule(schedule, now);
          schedule.updatedAt = now.toISOString();
        }
      }

      if (changed) {
        await this.store.save(draft);
        this.state = draft;
      }
      this.started = true;
      this.armTimer();
      return dispatches;
    });

    await Promise.all(pending.map((dispatch) => this.launchDispatch(dispatch)));
  }

  async stop(): Promise<void> {
    await this.exclusive(() => {
      this.started = false;
      if (this.timer !== undefined) {
        this.clock.clearTimeout(this.timer);
        this.timer = undefined;
      }
    });
  }

  async list(): Promise<ScheduleRecord[]> {
    return this.exclusive(() => structuredClone(this.state.schedules));
  }

  async get(id: string): Promise<ScheduleRecord> {
    return this.exclusive(() => structuredClone(requireSchedule(this.state, id)));
  }

  async history(id: string): Promise<ScheduleExecution[]> {
    return this.exclusive(() => {
      requireSchedule(this.state, id);
      return structuredClone(this.state.history[id] ?? []);
    });
  }

  async create(input: CreateScheduleInput): Promise<ScheduleRecord> {
    return this.exclusive(async () => {
      validateCreateInput(input);
      const now = this.clock.now();
      const task = cloneAndValidateTask(input.task);
      const trigger = cloneAndValidateTrigger(input.trigger);
      const enabled = input.enabled ?? true;
      const nextRunAt = enabled ? calculateFreshNextRun(trigger, now) : null;
      const timestamp = now.toISOString();
      const schedule: ScheduleRecord = {
        id: this.idFactory(),
        name: input.name.trim(),
        enabled,
        trigger,
        missedRun: input.missedRun ?? 'run_once',
        task,
        approval: approvalFor(task, timestamp),
        createdAt: timestamp,
        updatedAt: timestamp,
        nextRunAt,
        lastRun: null,
      };
      const draft = structuredClone(this.state);
      draft.schedules.push(schedule);
      draft.history[schedule.id] = [];
      await this.store.save(draft);
      this.state = draft;
      this.armTimer();
      return structuredClone(schedule);
    });
  }

  async update(id: string, input: UpdateScheduleInput): Promise<ScheduleRecord> {
    return this.exclusive(async () => {
      validateUpdateInput(input);
      const draft = structuredClone(this.state);
      const schedule = requireSchedule(draft, id);
      const authorityChanged = input.trigger !== undefined || input.task !== undefined || input.missedRun !== undefined;
      if (authorityChanged && input.approved !== true) {
        throw new SchedulerValidationError('approved must be true when changing schedule authority');
      }

      if (input.name !== undefined) schedule.name = validateName(input.name);
      if (input.trigger !== undefined) schedule.trigger = cloneAndValidateTrigger(input.trigger);
      if (input.missedRun !== undefined) schedule.missedRun = input.missedRun;
      if (input.task !== undefined) schedule.task = cloneAndValidateTask(input.task);

      const now = this.clock.now();
      if (authorityChanged) {
        schedule.approval = approvalFor(schedule.task, now.toISOString());
        if (schedule.enabled) schedule.nextRunAt = calculateFreshNextRun(schedule.trigger, now);
      }
      schedule.updatedAt = now.toISOString();
      await this.store.save(draft);
      this.state = draft;
      this.armTimer();
      return structuredClone(schedule);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduleRecord> {
    return this.exclusive(async () => {
      if (typeof enabled !== 'boolean') throw new SchedulerValidationError('enabled must be a boolean');
      const draft = structuredClone(this.state);
      const schedule = requireSchedule(draft, id);
      if (schedule.enabled === enabled) return structuredClone(schedule);
      const now = this.clock.now();
      schedule.enabled = enabled;
      schedule.nextRunAt = enabled ? calculateFreshNextRun(schedule.trigger, now) : null;
      schedule.updatedAt = now.toISOString();
      await this.store.save(draft);
      this.state = draft;
      this.armTimer();
      return structuredClone(schedule);
    });
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(async () => {
      const draft = structuredClone(this.state);
      const index = draft.schedules.findIndex((schedule) => schedule.id === id);
      if (index === -1) throw new ScheduleNotFoundError(id);
      draft.schedules.splice(index, 1);
      delete draft.history[id];
      await this.store.save(draft);
      this.state = draft;
      this.armTimer();
    });
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.lock.then(operation);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private armTimer(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.started) return;

    let next = Number.POSITIVE_INFINITY;
    for (const schedule of this.state.schedules) {
      if (!schedule.enabled || schedule.nextRunAt === null) continue;
      next = Math.min(next, Date.parse(schedule.nextRunAt));
    }
    if (!Number.isFinite(next)) return;

    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, next - this.clock.now().getTime()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.handleTimer().catch((error) => this.handleTimerFailure(error));
    }, delay);
  }

  private handleTimerFailure(error: unknown): void {
    this.onError?.(error);
    if (!this.started || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.handleTimer().catch((retryError) => this.handleTimerFailure(retryError));
    }, 1_000);
  }

  private async handleTimer(): Promise<void> {
    const pending = await this.exclusive(async () => {
      if (!this.started) return [];
      const now = this.clock.now();
      const draft = structuredClone(this.state);
      const dispatches: PendingDispatch[] = [];
      let changed = false;
      for (const schedule of draft.schedules) {
        if (!schedule.enabled || schedule.nextRunAt === null) continue;
        const scheduledTime = Date.parse(schedule.nextRunAt);
        if (scheduledTime > now.getTime()) continue;
        changed = true;
        if (schedule.missedRun === 'skip' && now.getTime() - scheduledTime > MISSED_GRACE_MS) {
          advanceSchedule(schedule, now);
          schedule.updatedAt = now.toISOString();
        } else {
          dispatches.push(beginExecution(draft, schedule, schedule.nextRunAt, now, this.idFactory));
        }
      }
      if (changed) {
        await this.store.save(draft);
        this.state = draft;
      }
      this.armTimer();
      return dispatches;
    });

    await Promise.all(pending.map((dispatch) => this.launchDispatch(dispatch)));
  }

  private async launchDispatch(pending: PendingDispatch): Promise<void> {
    let taskId: string;
    try {
      taskId = (await this.dispatcher.dispatch(structuredClone(pending.task))).id;
    } catch (error) {
      try {
        await this.finishDispatch(pending, 'failed', undefined, redactError(error));
      } catch (persistenceError) {
        this.onError?.(persistenceError);
      }
      return;
    }

    try {
      await this.finishDispatch(pending, 'dispatched', taskId);
    } catch (persistenceError) {
      this.onError?.(persistenceError);
    }
  }

  private async finishDispatch(
    pending: PendingDispatch,
    status: 'dispatched' | 'failed',
    taskId?: string,
    error?: string,
  ): Promise<void> {
    await this.exclusive(async () => {
      const current = this.state.history[pending.scheduleId]?.find((entry) => entry.id === pending.executionId);
      if (!current || current.status !== 'running') return;
      const draft = structuredClone(this.state);
      const execution = draft.history[pending.scheduleId]?.find((entry) => entry.id === pending.executionId);
      if (!execution) return;
      execution.status = status;
      execution.finishedAt = this.clock.now().toISOString();
      if (taskId !== undefined) execution.taskId = taskId;
      if (error !== undefined) execution.error = error;
      const schedule = draft.schedules.find((candidate) => candidate.id === pending.scheduleId);
      if (schedule?.lastRun?.id === execution.id) schedule.lastRun = structuredClone(execution);
      await this.store.save(draft);
      this.state = draft;
    });
  }
}

function beginExecution(
  state: PersistedSchedulerState,
  schedule: ScheduleRecord,
  scheduledFor: string,
  now: Date,
  idFactory: () => string,
): PendingDispatch {
  const execution: ScheduleExecution = {
    id: idFactory(),
    scheduleId: schedule.id,
    scheduledFor,
    startedAt: now.toISOString(),
    status: 'running',
  };
  const history = state.history[schedule.id] ?? [];
  history.unshift(execution);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  state.history[schedule.id] = history;
  schedule.lastRun = structuredClone(execution);
  schedule.updatedAt = now.toISOString();
  advanceSchedule(schedule, now);
  return { scheduleId: schedule.id, executionId: execution.id, task: structuredClone(schedule.task) };
}

function advanceSchedule(schedule: ScheduleRecord, now: Date): void {
  if (schedule.trigger.kind === 'once') {
    schedule.enabled = false;
    schedule.nextRunAt = null;
    return;
  }
  schedule.nextRunAt = nextRunAfter(schedule.trigger, now)?.toISOString() ?? null;
}

function markInterruptedExecutions(state: PersistedSchedulerState, now: Date): boolean {
  let changed = false;
  for (const [scheduleId, history] of Object.entries(state.history)) {
    for (const execution of history) {
      if (execution.status !== 'running') continue;
      execution.status = 'interrupted';
      execution.finishedAt = now.toISOString();
      execution.error = 'The application stopped before the task was dispatched.';
      changed = true;
      const schedule = state.schedules.find((candidate) => candidate.id === scheduleId);
      if (schedule?.lastRun?.id === execution.id) schedule.lastRun = structuredClone(execution);
    }
  }
  return changed;
}

function calculateFreshNextRun(trigger: ScheduleRecord['trigger'], now: Date): string {
  const next = nextRunAfter(trigger, now);
  if (next === null) throw new SchedulerValidationError('schedule has no occurrence after the current time');
  return next.toISOString();
}

function cloneAndValidateTrigger(trigger: ScheduleTrigger): ScheduleTrigger {
  validateTrigger(trigger);
  if (trigger.kind === 'once') {
    return { kind: 'once', runAt: new Date(trigger.runAt).toISOString() };
  }
  if (trigger.kind === 'interval') {
    return {
      kind: 'interval',
      everyMinutes: trigger.everyMinutes,
      anchorAt: new Date(trigger.anchorAt).toISOString(),
    };
  }
  return {
    kind: 'weekly',
    daysOfWeek: [...new Set(trigger.daysOfWeek)].sort((left, right) => left - right),
    time: trigger.time,
    timeZone: trigger.timeZone.trim(),
  };
}

function validateCreateInput(input: CreateScheduleInput): void {
  if (!input || typeof input !== 'object') throw new SchedulerValidationError('request body is required');
  validateName(input.name);
  if (input.approved !== true) throw new SchedulerValidationError('approved must be true');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new SchedulerValidationError('enabled must be a boolean');
  }
  validateMissedRun(input.missedRun ?? 'run_once');
}

function validateUpdateInput(input: UpdateScheduleInput): void {
  if (!input || typeof input !== 'object') throw new SchedulerValidationError('request body is required');
  if (input.name !== undefined) validateName(input.name);
  if (input.missedRun !== undefined) validateMissedRun(input.missedRun);
}

function validateName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '') throw new SchedulerValidationError('name is required');
  if (name.trim().length > 120) throw new SchedulerValidationError('name must be at most 120 characters');
  return name.trim();
}

function validateMissedRun(value: string): void {
  if (value !== 'skip' && value !== 'run_once') throw new SchedulerValidationError("missedRun must be 'skip' or 'run_once'");
}

function cloneAndValidateTask(task: ScheduledTaskSnapshot): ScheduledTaskSnapshot {
  if (!task || typeof task !== 'object') throw new SchedulerValidationError('task snapshot is required');
  if (typeof task.threadId !== 'string' || task.threadId.trim() === '') throw new SchedulerValidationError('task.threadId is required');
  if (typeof task.mode !== 'string' || task.mode.trim() === '') throw new SchedulerValidationError('task.mode is required');
  if (!Array.isArray(task.messages) || task.messages.length === 0) throw new SchedulerValidationError('task.messages must not be empty');
  if (task.messages.some((message) => !message || typeof message !== 'object' || typeof message.role !== 'string')) {
    throw new SchedulerValidationError('task.messages contains an invalid message');
  }
  if (!task.workspace || typeof task.workspace.path !== 'string' || !isAbsolute(task.workspace.path)) {
    throw new SchedulerValidationError('task.workspace.path must be an absolute path');
  }
  if (task.workspace.name !== undefined && typeof task.workspace.name !== 'string') {
    throw new SchedulerValidationError('task.workspace.name must be a string');
  }
  if (task.policy !== 'plan' && task.policy !== 'ask' && task.policy !== 'allow') {
    throw new SchedulerValidationError("task.policy must be 'plan', 'ask', or 'allow'");
  }
  if (!Array.isArray(task.enabledTools) || task.enabledTools.some((tool) => typeof tool !== 'string' || tool.trim() === '')) {
    throw new SchedulerValidationError('task.enabledTools must contain tool names');
  }
  if (task.systemPrompt !== undefined && typeof task.systemPrompt !== 'string') {
    throw new SchedulerValidationError('task.systemPrompt must be a string');
  }
  if (task.model !== undefined && typeof task.model !== 'string') {
    throw new SchedulerValidationError('task.model must be a string');
  }
  if (task.enabledSkillIds !== undefined && (!Array.isArray(task.enabledSkillIds) || task.enabledSkillIds.some((id) => typeof id !== 'string'))) {
    throw new SchedulerValidationError('task.enabledSkillIds must contain skill ids');
  }
  if (task.maxTokens !== undefined && (!Number.isInteger(task.maxTokens) || task.maxTokens < 1)) {
    throw new SchedulerValidationError('task.maxTokens must be a positive integer');
  }

  const workspaceName = task.workspace.name?.trim() || basename(task.workspace.path) || task.workspace.path;
  const normalized: ScheduledTaskSnapshot = {
    threadId: task.threadId.trim(),
    mode: task.mode.trim(),
    messages: structuredClone(task.messages),
    ...(task.systemPrompt !== undefined && { systemPrompt: task.systemPrompt }),
    workspace: { path: task.workspace.path, name: workspaceName },
    policy: task.policy,
    enabledTools: [...new Set(task.enabledTools.map((tool) => tool.trim()))],
    enabledSkillIds: [...new Set(task.enabledSkillIds ?? [])],
    ...(task.model !== undefined && { model: task.model }),
    ...(task.maxTokens !== undefined && { maxTokens: task.maxTokens }),
  };
  return redactValue(normalized) as ScheduledTaskSnapshot;
}

function approvalFor(task: ScheduledTaskSnapshot, approvedAt: string): ScheduleApprovalSnapshot {
  return {
    approvedAt,
    threadId: task.threadId,
    workspace: structuredClone(task.workspace),
    policy: task.policy,
    enabledTools: [...task.enabledTools],
    enabledSkillIds: [...task.enabledSkillIds],
  };
}

function requireSchedule(state: PersistedSchedulerState, id: string): ScheduleRecord {
  const schedule = state.schedules.find((candidate) => candidate.id === id);
  if (!schedule) throw new ScheduleNotFoundError(id);
  return schedule;
}

function validatePersistedState(state: PersistedSchedulerState): void {
  const ids = new Set<string>();
  for (const schedule of state.schedules) {
    if (!schedule || typeof schedule.id !== 'string' || schedule.id === '' || ids.has(schedule.id)) {
      throw new Error('Scheduler state contains a missing or duplicate schedule id');
    }
    ids.add(schedule.id);
    if (typeof schedule.enabled !== 'boolean' || (schedule.enabled && schedule.nextRunAt === null) || (!schedule.enabled && schedule.nextRunAt !== null)) {
      throw new Error(`Scheduler state contains an inconsistent enabled state for '${schedule.id}'`);
    }
    validateName(schedule.name);
    validateTrigger(schedule.trigger);
    validateMissedRun(schedule.missedRun);
    cloneAndValidateTask(schedule.task);
    const approvalMatches = schedule.approval
      && Number.isFinite(Date.parse(schedule.approval.approvedAt))
      && schedule.approval.threadId === schedule.task.threadId
      && schedule.approval.policy === schedule.task.policy
      && schedule.approval.workspace?.path === schedule.task.workspace.path
      && schedule.approval.workspace.name === schedule.task.workspace.name
      && Array.isArray(schedule.approval.enabledTools)
      && schedule.approval.enabledTools.length === schedule.task.enabledTools.length
      && schedule.approval.enabledTools.every((tool, index) => tool === schedule.task.enabledTools[index])
      && Array.isArray(schedule.approval.enabledSkillIds)
      && schedule.approval.enabledSkillIds.length === schedule.task.enabledSkillIds.length
      && schedule.approval.enabledSkillIds.every((id, index) => id === schedule.task.enabledSkillIds[index]);
    if (!approvalMatches) throw new Error(`Scheduler state contains a stale approval snapshot for '${schedule.id}'`);
    for (const value of [schedule.createdAt, schedule.updatedAt, schedule.nextRunAt].filter((item): item is string => item !== null)) {
      if (!Number.isFinite(Date.parse(value))) throw new Error(`Scheduler state contains an invalid timestamp for '${schedule.id}'`);
    }

    const history = state.history[schedule.id];
    if (!Array.isArray(history) || history.length > HISTORY_LIMIT) {
      throw new Error(`Scheduler state contains invalid history for '${schedule.id}'`);
    }
    for (const execution of history) validatePersistedExecution(execution, schedule.id);
    if (schedule.lastRun !== null && !history.some((execution) => execution.id === schedule.lastRun?.id)) {
      throw new Error(`Scheduler state contains a last run outside history for '${schedule.id}'`);
    }
  }
  if (Object.keys(state.history).some((scheduleId) => !ids.has(scheduleId))) {
    throw new Error('Scheduler state contains history for a deleted schedule');
  }
}

function validatePersistedExecution(execution: ScheduleExecution, scheduleId: string): void {
  const statusValid = execution?.status === 'running'
    || execution?.status === 'dispatched'
    || execution?.status === 'failed'
    || execution?.status === 'interrupted';
  if (!execution || typeof execution.id !== 'string' || execution.scheduleId !== scheduleId || !statusValid) {
    throw new Error(`Scheduler state contains an invalid execution for '${scheduleId}'`);
  }
  for (const value of [execution.scheduledFor, execution.startedAt, execution.finishedAt].filter((item): item is string => item !== undefined)) {
    if (!Number.isFinite(Date.parse(value))) throw new Error(`Scheduler state contains an invalid execution timestamp for '${scheduleId}'`);
  }
}

function redactError(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  return redactText(source).slice(0, 1_000);
}
