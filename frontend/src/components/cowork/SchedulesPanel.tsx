import { useCallback, useEffect, useState } from 'react';
import { IconEdit, IconPlus, IconSpinner, IconTrash } from '../Icons';

type SchedulePolicy = 'plan' | 'ask' | 'allow';
type MissedRunPolicy = 'skip' | 'run_once';

type ScheduleTrigger =
  | { kind: 'once'; runAt: string }
  | { kind: 'interval'; everyMinutes: number; anchorAt: string }
  | { kind: 'weekly'; daysOfWeek: number[]; time: string; timeZone: string };

interface TaskSnapshot {
  threadId: string;
  mode: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> | null;
  }>;
  systemPrompt?: string;
  workspace: { path: string; name?: string };
  policy: SchedulePolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
  model?: string;
}

interface ScheduleExecution {
  id: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'dispatched' | 'failed' | 'interrupted';
  taskId?: string;
  error?: string;
}

interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  missedRun: MissedRunPolicy;
  task: TaskSnapshot;
  approval: {
    approvedAt: string;
    threadId: string;
    workspace: { path: string; name?: string };
    policy: SchedulePolicy;
    enabledTools: string[];
    enabledSkillIds: string[];
  };
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun: ScheduleExecution | null;
}

type DraftKind = 'once' | 'daily' | 'weekly' | 'interval';

interface ScheduleDraft {
  name: string;
  prompt: string;
  systemPrompt: string;
  workspacePath: string;
  workspaceName: string;
  policy: SchedulePolicy;
  enabledTools: string[];
  enabledSkillIds: string[];
  kind: DraftKind;
  onceAt: string;
  time: string;
  daysOfWeek: number[];
  everyMinutes: string;
  intervalAnchorAt: string;
  timeZone: string;
  missedRun: MissedRunPolicy;
  threadId: string;
  mode: string;
  model: string;
}

interface ToolCapability {
  name: string;
  description: string;
}

const DAYS = [
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
] as const;


export default function SchedulesPanel() {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [tools, setTools] = useState<ToolCapability[]>([]);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, ScheduleExecution[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSchedules = useCallback(async (signal?: AbortSignal) => {
    const [scheduleResponse, capabilityResponse] = await Promise.all([
      requestJson<{ schedules: ScheduleRecord[] }>('/desktop/schedules', { signal }),
      requestJson<{ tools: ToolCapability[] }>('/desktop/capabilities', { signal }),
    ]);
    setSchedules(scheduleResponse.schedules);
    setTools(capabilityResponse.tools);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void loadSchedules(controller.signal)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadSchedules]);

  const beginCreate = () => {
    const nextDraft = emptyDraft();
    const availableNames = new Set(tools.map((tool) => tool.name));
    nextDraft.enabledTools = nextDraft.enabledTools.filter((tool) => availableNames.has(tool));
    setEditingId(null);
    setDraft(nextDraft);
    setError(null);
  };

  const beginEdit = (schedule: ScheduleRecord) => {
    setEditingId(schedule.id);
    setDraft(draftFromSchedule(schedule));
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const payload = payloadFromDraft(draft);
      if (editingId) {
        const response = await requestJson<{ schedule: ScheduleRecord }>(`/desktop/schedules/${encodeURIComponent(editingId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setSchedules((current) => current.map((item) => item.id === response.schedule.id ? response.schedule : item));
      } else {
        const response = await requestJson<{ schedule: ScheduleRecord }>('/desktop/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, enabled: true }),
        });
        setSchedules((current) => [...current, response.schedule]);
      }
      setDraft(null);
      setEditingId(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const chooseWorkspace = async () => {
    setError(null);
    try {
      const workspace = await requestJson<{ path: string; name: string } | undefined>('/desktop/workspace/select', { method: 'POST' });
      if (workspace) {
        setDraft((current) => current ? { ...current, workspacePath: workspace.path, workspaceName: workspace.name } : current);
      }
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const toggleEnabled = async (schedule: ScheduleRecord) => {
    setError(null);
    try {
      const response = await requestJson<{ schedule: ScheduleRecord }>(`/desktop/schedules/${encodeURIComponent(schedule.id)}/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      });
      setSchedules((current) => current.map((item) => item.id === response.schedule.id ? response.schedule : item));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const removeSchedule = async (schedule: ScheduleRecord) => {
    if (!window.confirm(`Delete “${schedule.name}” and its execution history?`)) return;
    setError(null);
    try {
      await requestJson<void>(`/desktop/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' });
      setSchedules((current) => current.filter((item) => item.id !== schedule.id));
      setExpandedId((current) => current === schedule.id ? null : current);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const toggleHistory = async (schedule: ScheduleRecord) => {
    if (expandedId === schedule.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(schedule.id);
    setHistoryById((current) => {
      const next = { ...current };
      delete next[schedule.id];
      return next;
    });
    setError(null);
    try {
      const [historyResponse, scheduleResponse] = await Promise.all([
        requestJson<{ history: ScheduleExecution[] }>(`/desktop/schedules/${encodeURIComponent(schedule.id)}/history`),
        requestJson<{ schedule: ScheduleRecord }>(`/desktop/schedules/${encodeURIComponent(schedule.id)}`),
      ]);
      setHistoryById((current) => ({ ...current, [schedule.id]: historyResponse.history }));
      setSchedules((current) => current.map((item) => item.id === schedule.id ? scheduleResponse.schedule : item));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-accent">TAWX Desktop</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Schedules</h1>
            <p className="mt-2 max-w-2xl text-sm text-surface-500">
              Run a saved task automatically with the workspace and approval policy shown here.
            </p>
          </div>
          {!draft && (
            <button type="button" className="btn-primary flex items-center gap-2" onClick={beginCreate}>
              <IconPlus className="h-4 w-4" /> New schedule
            </button>
          )}
        </header>

        {error && <div role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

        {draft && (
          <ScheduleForm
            draft={draft}
            tools={tools}
            editing={editingId !== null}
            saving={saving}
            onChange={setDraft}
            onChooseWorkspace={() => void chooseWorkspace()}
            onCancel={() => { setDraft(null); setEditingId(null); }}
            onSave={() => void save()}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-surface-500"><IconSpinner className="mr-2 h-5 w-5" /> Loading schedules</div>
        ) : schedules.length === 0 && !draft ? (
          <div className="rounded-2xl border border-dashed border-surface-300 px-6 py-14 text-center dark:border-surface-700">
            <p className="font-medium">No schedules yet</p>
            <p className="mt-1 text-sm text-surface-500">Create one to run a real saved task while TAWX Desktop is open.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {schedules.map((schedule) => (
              <article key={schedule.id} className="overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-800">
                <div className="p-4 sm:p-5">
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold">{schedule.name}</h2>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${schedule.enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-surface-100 text-surface-500 dark:bg-surface-800'}`}>
                          {schedule.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-500 dark:bg-surface-800">{policyLabel(schedule.approval.policy)}</span>
                      </div>
                      <p className="mt-1 text-sm text-accent">{triggerLabel(schedule.trigger)}</p>
                      <p className="mt-2 line-clamp-2 text-sm text-surface-500">{promptFromTask(schedule.task)}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${schedule.enabled ? 'Disable' : 'Enable'} ${schedule.name}`}
                      aria-checked={schedule.enabled}
                      onClick={() => void toggleEnabled(schedule)}
                      className={`mt-1 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${schedule.enabled ? 'bg-accent' : 'bg-surface-200 dark:bg-surface-700'}`}
                    >
                      <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${schedule.enabled ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>

                  <dl className="mt-4 grid gap-3 border-t border-surface-100 pt-4 text-xs dark:border-surface-800 sm:grid-cols-2">
                    <div><dt className="text-surface-500">Next run</dt><dd className="mt-0.5 font-medium">{schedule.nextRunAt ? formatInstant(schedule.nextRunAt) : 'Not scheduled'}</dd></div>
                    <div><dt className="text-surface-500">Last run</dt><dd className="mt-0.5 font-medium">{schedule.lastRun ? `${formatInstant(schedule.lastRun.startedAt)} · ${executionLabel(schedule.lastRun.status)}` : 'Never'}</dd></div>
                  </dl>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button type="button" className="btn-ghost border border-surface-200 dark:border-surface-700" onClick={() => void toggleHistory(schedule)}>
                      {expandedId === schedule.id ? 'Hide details' : 'Details & history'}
                    </button>
                    <button type="button" className="btn-ghost flex items-center gap-1.5 border border-surface-200 dark:border-surface-700" onClick={() => beginEdit(schedule)}>
                      <IconEdit className="h-3.5 w-3.5" /> Edit
                    </button>
                    <button type="button" className="btn-ghost ml-auto flex items-center gap-1.5 text-red-600 dark:text-red-400" onClick={() => void removeSchedule(schedule)}>
                      <IconTrash className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                </div>

                {expandedId === schedule.id && (
                  <ScheduleDetails schedule={schedule} history={historyById[schedule.id]} />
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleForm({
  draft,
  tools,
  editing,
  saving,
  onChange,
  onChooseWorkspace,
  onCancel,
  onSave,
}: {
  tools: ToolCapability[];
  draft: ScheduleDraft;
  editing: boolean;
  saving: boolean;
  onChange: (draft: ScheduleDraft) => void;
  onChooseWorkspace: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const canSave = draft.name.trim() !== '' && draft.prompt.trim() !== '' && draft.workspacePath.trim() !== ''
    && (draft.kind !== 'weekly' || draft.daysOfWeek.length > 0)
    && (draft.kind !== 'interval' || Number(draft.everyMinutes) >= 1);
  const availableNames = new Set(tools.map((tool) => tool.name));
  const visibleTools = [
    ...tools,
    ...draft.enabledTools
      .filter((name) => !availableNames.has(name))
      .map((name) => ({ name, description: 'This tool is not currently registered.' })),
  ];

  return (
    <form className="mb-5 space-y-5 rounded-2xl border border-accent/30 bg-accent/5 p-4 sm:p-5" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{editing ? 'Edit schedule' : 'New schedule'}</h2><span className="text-xs text-surface-500">All fields are saved on this device</span></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="label">Name</span><input className="input" required maxLength={120} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="Morning project check" /></label>
        <label className="block"><span className="label">Model <span className="font-normal text-surface-500">(optional)</span></span><input className="input" value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value })} placeholder="Use current routing" /></label>
      </div>
      <label className="block"><span className="label">Task</span><textarea className="input min-h-24 resize-y" required value={draft.prompt} onChange={(event) => onChange({ ...draft, prompt: event.target.value })} placeholder="Review this workspace and summarize new issues." /></label>
      <label className="block"><span className="label">System prompt <span className="font-normal text-surface-500">(optional)</span></span><textarea className="input min-h-16 resize-y" value={draft.systemPrompt} onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })} /></label>
      <div>
        <span className="label">Workspace</span>
        <div className="flex gap-2"><input className="input" required value={draft.workspacePath} onChange={(event) => onChange({ ...draft, workspacePath: event.target.value, workspaceName: '' })} placeholder="/absolute/path/to/project" /><button type="button" className="btn-ghost shrink-0 border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-900" onClick={onChooseWorkspace}>Choose folder</button></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block"><span className="label">Repeats</span><select className="input" value={draft.kind} onChange={(event) => onChange({ ...draft, kind: event.target.value as DraftKind })}><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="interval">At an interval</option></select></label>
        {draft.kind === 'once' && <label className="block sm:col-span-2"><span className="label">Run at</span><input type="datetime-local" className="input" required value={draft.onceAt} onChange={(event) => onChange({ ...draft, onceAt: event.target.value })} /></label>}
        {(draft.kind === 'daily' || draft.kind === 'weekly') && <label className="block"><span className="label">Time</span><input type="time" className="input" required value={draft.time} onChange={(event) => onChange({ ...draft, time: event.target.value })} /><span className="hint">{draft.timeZone}</span></label>}
        {draft.kind === 'interval' && <label className="block"><span className="label">Every (minutes)</span><input type="number" min={1} max={525600} className="input" required value={draft.everyMinutes} onChange={(event) => onChange({ ...draft, everyMinutes: event.target.value })} /></label>}
        <label className="block"><span className="label">If the app missed a run</span><select className="input" value={draft.missedRun} onChange={(event) => onChange({ ...draft, missedRun: event.target.value as MissedRunPolicy })}><option value="run_once">Run once when it reopens</option><option value="skip">Skip it</option></select></label>
      </div>
      {draft.kind === 'weekly' && (
        <fieldset><legend className="label">Days</legend><div className="flex flex-wrap gap-2">{DAYS.map(([label, day]) => <label key={day} className={`cursor-pointer rounded-lg border px-3 py-2 text-xs ${draft.daysOfWeek.includes(day) ? 'border-accent bg-accent/10 text-accent' : 'border-surface-200 dark:border-surface-700'}`}><input type="checkbox" className="sr-only" checked={draft.daysOfWeek.includes(day)} onChange={() => onChange({ ...draft, daysOfWeek: draft.daysOfWeek.includes(day) ? draft.daysOfWeek.filter((value) => value !== day) : [...draft.daysOfWeek, day].sort() })} />{label}</label>)}</div></fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="label">Approved policy</span><select className="input" value={draft.policy} onChange={(event) => onChange({ ...draft, policy: event.target.value as SchedulePolicy })}><option value="plan">Plan only — no changes</option><option value="ask">Ask before changes</option><option value="allow">Allow enabled tools</option></select></label>
        <fieldset><legend className="label">Enabled tools</legend><div className="grid grid-cols-2 gap-x-3 gap-y-1.5">{visibleTools.map((tool) => <label key={tool.name} className="flex items-center gap-2 text-xs" title={tool.description}><input type="checkbox" checked={draft.enabledTools.includes(tool.name)} onChange={() => onChange({ ...draft, enabledTools: draft.enabledTools.includes(tool.name) ? draft.enabledTools.filter((value) => value !== tool.name) : [...draft.enabledTools, tool.name] })} className="accent-accent" />{tool.name}{!availableNames.has(tool.name) && <span className="text-amber-600">(unavailable)</span>}</label>)}</div></fieldset>
      </div>
      <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs leading-5 text-amber-800 dark:text-amber-300">
        Saving approves this exact task, thread, workspace, policy, and tool list for future automatic runs. Editing any of them records a new approval snapshot.
      </div>
      <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button><button type="submit" className="btn-primary flex items-center gap-2" disabled={!canSave || saving}>{saving && <IconSpinner className="h-4 w-4" />}{editing ? 'Save & approve' : 'Create & approve'}</button></div>
    </form>
  );
}

function ScheduleDetails({ schedule, history }: { schedule: ScheduleRecord; history?: ScheduleExecution[] }) {
  return (
    <div className="border-t border-surface-200 bg-surface-50 p-4 dark:border-surface-800 dark:bg-surface-900/50 sm:p-5">
      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <div><dt className="text-surface-500">Approved workspace</dt><dd className="mt-0.5 break-all font-mono">{schedule.approval.workspace.path}</dd></div>
        <div><dt className="text-surface-500">Approval snapshot</dt><dd className="mt-0.5">{policyLabel(schedule.approval.policy)} · {formatInstant(schedule.approval.approvedAt)}</dd></div>
        <div><dt className="text-surface-500">Thread snapshot</dt><dd className="mt-0.5 break-all font-mono">{schedule.approval.threadId}</dd></div>
        <div><dt className="text-surface-500">Missed runs</dt><dd className="mt-0.5">{schedule.missedRun === 'run_once' ? 'Run one catch-up task' : 'Skip missed occurrences'}</dd></div>
        <div className="sm:col-span-2"><dt className="text-surface-500">Approved tools</dt><dd className="mt-0.5">{schedule.approval.enabledTools.length > 0 ? schedule.approval.enabledTools.join(', ') : 'None'}</dd></div>
        <div className="sm:col-span-2"><dt className="text-surface-500">Approved skills</dt><dd className="mt-0.5">{schedule.approval.enabledSkillIds.length > 0 ? schedule.approval.enabledSkillIds.join(', ') : 'None'}</dd></div>
      </dl>
      <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-surface-500">Execution history</h3>
      {history === undefined ? <p className="text-sm text-surface-500">Loading history…</p> : history.length === 0 ? <p className="text-sm text-surface-500">No runs yet.</p> : <div className="space-y-2">{history.map((execution) => <div key={execution.id} className="rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs dark:border-surface-800 dark:bg-surface-900"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{executionLabel(execution.status)}</span><time className="text-surface-500">{formatInstant(execution.startedAt)}</time></div>{execution.taskId && <p className="mt-1 break-all text-surface-500">Task {execution.taskId}</p>}{execution.error && <p className="mt-1 text-red-600 dark:text-red-400">{execution.error}</p>}</div>)}</div>}
    </div>
  );
}

function emptyDraft(): ScheduleDraft {
  const future = new Date(Date.now() + 60 * 60 * 1_000);
  future.setSeconds(0, 0);
  return {
    name: '',
    prompt: '',
    systemPrompt: '',
    workspacePath: '',
    workspaceName: '',
    policy: 'ask',
    enabledTools: ['read_file', 'list_directory'],
    enabledSkillIds: [],
    kind: 'once',
    onceAt: toLocalInput(future),
    time: '09:00',
    daysOfWeek: [1, 2, 3, 4, 5],
    everyMinutes: '60',
    intervalAnchorAt: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    missedRun: 'run_once',
    threadId: crypto.randomUUID(),
    mode: 'cowork',
    model: '',
  };
}

function draftFromSchedule(schedule: ScheduleRecord): ScheduleDraft {
  const draft = emptyDraft();
  const trigger = schedule.trigger;
  const kind: DraftKind = trigger.kind === 'weekly' && trigger.daysOfWeek.length === 7 ? 'daily' : trigger.kind;
  return {
    ...draft,
    name: schedule.name,
    prompt: promptFromTask(schedule.task),
    systemPrompt: schedule.task.systemPrompt ?? '',
    workspacePath: schedule.task.workspace.path,
    workspaceName: schedule.task.workspace.name ?? '',
    policy: schedule.task.policy,
    enabledTools: [...schedule.task.enabledTools],
    enabledSkillIds: [...schedule.task.enabledSkillIds],
    kind,
    onceAt: trigger.kind === 'once' ? toLocalInput(new Date(trigger.runAt)) : draft.onceAt,
    time: trigger.kind === 'weekly' ? trigger.time : draft.time,
    daysOfWeek: trigger.kind === 'weekly' ? [...trigger.daysOfWeek] : draft.daysOfWeek,
    everyMinutes: trigger.kind === 'interval' ? String(trigger.everyMinutes) : draft.everyMinutes,
    intervalAnchorAt: trigger.kind === 'interval' ? trigger.anchorAt : draft.intervalAnchorAt,
    timeZone: trigger.kind === 'weekly' ? trigger.timeZone : draft.timeZone,
    missedRun: schedule.missedRun,
    threadId: schedule.task.threadId,
    mode: schedule.task.mode,
    model: schedule.task.model ?? '',
  };
}

function payloadFromDraft(draft: ScheduleDraft) {
  let trigger: ScheduleTrigger;
  if (draft.kind === 'once') {
    trigger = { kind: 'once', runAt: new Date(draft.onceAt).toISOString() };
  } else if (draft.kind === 'interval') {
    trigger = { kind: 'interval', everyMinutes: Number(draft.everyMinutes), anchorAt: draft.intervalAnchorAt };
  } else {
    trigger = {
      kind: 'weekly',
      daysOfWeek: draft.kind === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : draft.daysOfWeek,
      time: draft.time,
      timeZone: draft.timeZone,
    };
  }
  return {
    name: draft.name.trim(),
    trigger,
    missedRun: draft.missedRun,
    task: {
      threadId: draft.threadId,
      mode: draft.mode,
      messages: [{ role: 'user', content: draft.prompt.trim() }],
      ...(draft.systemPrompt.trim() && { systemPrompt: draft.systemPrompt.trim() }),
      workspace: {
        path: draft.workspacePath.trim(),
        name: draft.workspaceName || draft.workspacePath.split('/').filter(Boolean).at(-1) || draft.workspacePath.trim(),
      },
      policy: draft.policy,
      enabledTools: draft.enabledTools,
      enabledSkillIds: draft.enabledSkillIds,
      ...(draft.model.trim() && { model: draft.model.trim() }),
    },
    approved: true as const,
  };
}

function promptFromTask(task: TaskSnapshot): string {
  const message = [...task.messages].reverse().find((item) => item.role === 'user');
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .map((part) => part.text ?? (part.image_url ? '[Image attachment]' : ''))
    .filter(Boolean)
    .join('\n');
}

function triggerLabel(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'once') return `Once · ${formatInstant(trigger.runAt)}`;
  if (trigger.kind === 'interval') return `Every ${trigger.everyMinutes} minute${trigger.everyMinutes === 1 ? '' : 's'}`;
  const everyDay = trigger.daysOfWeek.length === 7;
  const days = everyDay ? 'Every day' : DAYS.filter(([, day]) => trigger.daysOfWeek.includes(day)).map(([label]) => label).join(', ');
  return `${days} at ${trigger.time} · ${trigger.timeZone}`;
}

function policyLabel(policy: SchedulePolicy): string {
  if (policy === 'plan') return 'Plan only';
  if (policy === 'ask') return 'Ask before changes';
  return 'Allowed tools';
}

function executionLabel(status: ScheduleExecution['status']): string {
  if (status === 'running') return 'Dispatching';
  if (status === 'dispatched') return 'Task dispatched';
  if (status === 'interrupted') return 'Interrupted';
  return 'Failed';
}

function formatInstant(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function toLocalInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  return payload as T;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'The scheduler request failed';
}
