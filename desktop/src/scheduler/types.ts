import type {
  AgentTaskRequest,
  TaskDispatcher as AgentTaskDispatcher,
  TaskPolicy,
  WorkspaceSnapshot,
} from '../agent/types.js';

export type SchedulePolicy = TaskPolicy;
export type MissedRunPolicy = 'skip' | 'run_once';

export interface OnceTrigger {
  kind: 'once';
  /** Absolute ISO-8601 instant. */
  runAt: string;
}

export interface IntervalTrigger {
  kind: 'interval';
  everyMinutes: number;
  /** Absolute ISO-8601 instant from which intervals are measured. */
  anchorAt: string;
}

export interface WeeklyTrigger {
  kind: 'weekly';
  /** Sunday is 0 and Saturday is 6. */
  daysOfWeek: number[];
  /** Wall-clock time in HH:mm form. */
  time: string;
  /** IANA time zone used to interpret the wall-clock fields. */
  timeZone: string;
}

export type ScheduleTrigger = OnceTrigger | IntervalTrigger | WeeklyTrigger;

export type ScheduledWorkspace = WorkspaceSnapshot;

/**
 * Immutable input captured when a user approves a schedule. The dispatcher gets
 * this exact snapshot; it never consults current thread, workspace, or policy
 * settings at run time.
 */
export interface ScheduledTaskSnapshot extends AgentTaskRequest {
  workspace: ScheduledWorkspace;
  policy: SchedulePolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
}

export interface ScheduleApprovalSnapshot {
  approvedAt: string;
  threadId: string;
  workspace: ScheduledWorkspace;
  policy: SchedulePolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
}

export type ScheduleExecutionStatus = 'running' | 'dispatched' | 'failed' | 'interrupted';

export interface ScheduleExecution {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: ScheduleExecutionStatus;
  taskId?: string;
  error?: string;
}

export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  missedRun: MissedRunPolicy;
  task: ScheduledTaskSnapshot;
  approval: ScheduleApprovalSnapshot;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun: ScheduleExecution | null;
}

export interface CreateScheduleInput {
  name: string;
  enabled?: boolean;
  trigger: ScheduleTrigger;
  missedRun?: MissedRunPolicy;
  task: ScheduledTaskSnapshot;
  /** Required acknowledgement that the task snapshot may run unattended. */
  approved: true;
}

export interface UpdateScheduleInput {
  name?: string;
  trigger?: ScheduleTrigger;
  missedRun?: MissedRunPolicy;
  task?: ScheduledTaskSnapshot;
  /** Required whenever trigger or task authority is changed. */
  approved?: true;
}

export type TaskDispatcher = AgentTaskDispatcher;

export interface SchedulerClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PersistedSchedulerState {
  version: 1;
  schedules: ScheduleRecord[];
  history: Record<string, ScheduleExecution[]>;
}
