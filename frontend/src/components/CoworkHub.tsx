import { useEffect, useMemo, useState } from 'react';
import type { CoworkSection, CoworkTask, TaskApproval } from '../types';
import { useChats } from '../store/useChats';
import { useToolCapabilities } from '../store/useToolCapabilities';
import ApprovalRequestCard, {
  type ApprovalDecision,
  type ToolApprovalRequest,
} from './cowork/ApprovalRequestCard';
import AuditHistory from './cowork/AuditHistory';
import IntegrationsPanel from './cowork/IntegrationsPanel';
import SchedulesPanel from './cowork/SchedulesPanel';
import SkillsPanel, { type SkillsPanelSelection } from './cowork/SkillsPanel';
import ToolPermissionsPanel, { type TaskPolicy } from './cowork/ToolPermissionsPanel';

export default function CoworkHub({ section }: { section: Exclude<CoworkSection, 'tasks'> }) {
  if (section === 'schedules') return <SchedulesPanel />;
  if (section === 'tools') return <ToolsHub />;
  return <SkillsSurface />;
}

function SkillsSurface() {
  const workspacePath = useChats((state) => state.workspace?.path);
  const threadId = useChats((state) => state.activeChat?.id);
  const setThreadEnabledSkills = useChats((state) => state.setThreadEnabledSkills);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const syncContextSelection = (selection: SkillsPanelSelection) => {
    const current = useChats.getState().enabledSkillIds;
    if (current.length === selection.enabledSkillIds.length
      && current.every((id, index) => id === selection.enabledSkillIds[index])) return;
    setSelectionError(null);
    void setThreadEnabledSkills(selection.enabledSkillIds).catch((cause: unknown) => {
      setSelectionError(messageOf(cause, 'Could not apply the skill selection to this conversation.'));
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectionError && (
        <div role="alert" className="m-3 mb-0 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {selectionError}
        </div>
      )}
      <SkillsPanel
        workspacePath={workspacePath}
        threadId={threadId}
        onEnabledSkillsChange={syncContextSelection}
      />
    </div>
  );
}

function ToolsHub() {
  const [view, setView] = useState<'permissions' | 'integrations'>('permissions');
  const workspacePath = useChats((state) => state.workspace?.path);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Tools views" className="flex shrink-0 justify-center gap-1 border-b border-surface-200 px-4 py-2 dark:border-surface-800">
        <ViewButton selected={view === 'permissions'} onClick={() => setView('permissions')}>
          Permissions & audit
        </ViewButton>
        <ViewButton selected={view === 'integrations'} onClick={() => setView('integrations')}>
          Integrations & artifacts
        </ViewButton>
      </nav>
      {view === 'permissions' ? <ToolsSurface /> : <IntegrationsPanel workspacePath={workspacePath} />}
    </div>
  );
}

function ViewButton({ selected, onClick, children }: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        selected ? 'bg-accent text-white' : 'text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800'
      }`}
    >
      {children}
    </button>
  );
}

function ToolsSurface() {
  const activeChat = useChats((state) => state.activeChat);
  const workspace = useChats((state) => state.workspace);
  const policy = useChats((state) => state.policy);
  const enabledTools = useChats((state) => state.enabledTools);
  const activeTask = useChats((state) => state.activeTask);
  const stateError = useChats((state) => state.error);
  const setThreadPolicy = useChats((state) => state.setThreadPolicy);
  const toggleThreadTool = useChats((state) => state.toggleThreadTool);
  const selectWorkspace = useChats((state) => state.selectWorkspace);
  const respondToApproval = useChats((state) => state.respondToApproval);
  const clearError = useChats((state) => state.clearError);
  const tools = useToolCapabilities((state) => state.tools);
  const runtimeStatus = useToolCapabilities((state) => state.status);
  const runtimeError = useToolCapabilities((state) => state.error);
  const loadCapabilities = useToolCapabilities((state) => state.load);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const pendingApprovals = useMemo(
    () => activeTask
      ? activeTask.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approvalRequest(activeTask, approval))
      : [],
    [activeTask],
  );

  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  const changePolicy = (nextPolicy: TaskPolicy) => {
    setSettingsError(null);
    void setThreadPolicy(nextPolicy).catch((cause: unknown) => {
      setSettingsError(messageOf(cause, 'Could not save the task policy.'));
    });
  };

  const toggleTool = (name: string) => {
    setSettingsError(null);
    void toggleThreadTool(name).catch((cause: unknown) => {
      setSettingsError(messageOf(cause, 'Could not save the tool selection.'));
    });
  };

  const decide = async (approvalId: string, decision: ApprovalDecision) => {
    if (!activeTask) return;
    clearError();
    await respondToApproval(approvalId, decision, activeTask.id);
  };

  return (
    <Panel title="Tools" description="Choose the capabilities and approval policy used by the next task in this conversation.">
      {(settingsError || stateError) && (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          <span>{settingsError ?? stateError}</span>
          <button
            type="button"
            onClick={() => {
              setSettingsError(null);
              if (stateError) clearError();
            }}
            className="shrink-0 font-medium hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      <ToolPermissionsPanel
        scopeLabel={activeChat ? `“${activeChat.title}”` : 'the new task draft'}
        workspacePath={workspace?.path}
        policy={policy}
        enabledTools={enabledTools}
        tools={tools}
        runtimeStatus={runtimeStatus}
        runtimeError={runtimeError}
        onPolicyChange={changePolicy}
        onToggleTool={toggleTool}
        onRefreshCapabilities={() => void loadCapabilities(true)}
        onSelectWorkspace={() => void selectWorkspace()}
      />

      <section className="space-y-3" aria-labelledby="pending-approvals-title">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="pending-approvals-title" className="font-semibold">Pending approvals</h2>
            <p className="mt-1 text-sm text-surface-500">Review every tool request waiting on the active task.</p>
          </div>
          <span className="rounded-full bg-surface-100 px-2.5 py-1 text-xs text-surface-500 dark:bg-surface-800">
            {pendingApprovals.length}
          </span>
        </div>
        {pendingApprovals.length === 0 ? (
          <p className="rounded-xl border border-surface-200 px-3 py-4 text-sm text-surface-500 dark:border-surface-800">
            No tool requests are waiting for approval.
          </p>
        ) : pendingApprovals.map((approval) => (
          <ApprovalRequestCard
            key={approval.id}
            approval={approval}
            onDecision={(decision) => decide(approval.id, decision)}
          />
        ))}
      </section>

      <AuditHistory events={activeTask?.events ?? []} />
    </Panel>
  );
}

function approvalRequest(task: CoworkTask, approval: TaskApproval): ToolApprovalRequest {
  const descriptor = findApprovalDescriptor(task, approval.id) ?? recordOf(approval.arguments);
  const relatedDiffs = task.diffs.filter((diff) => diff.toolCallId === approval.toolCallId && diff.diff);
  const recordedDiff = relatedDiffs.length > 0
    ? relatedDiffs.map((diff) => `${diff.path}\n${diff.diff}`).join('\n\n')
    : null;
  const descriptorDiff = typeof descriptor?.diff === 'string' ? descriptor.diff : null;

  return {
    id: approval.id,
    taskId: task.id,
    toolName: approval.tool,
    input: descriptor && 'input' in descriptor ? descriptor.input : approval.arguments,
    risk: normalizeRisk(descriptor?.risk, approval.reason),
    diff: descriptorDiff || recordedDiff,
    requestedAt: approval.requestedAt,
  };
}

function findApprovalDescriptor(task: CoworkTask, approvalId: string): Record<string, unknown> | null {
  for (let index = task.events.length - 1; index >= 0; index -= 1) {
    const event = task.events[index];
    if (event.kind !== 'approval_required') continue;
    const payload = recordOf(event.payload);
    const descriptor = recordOf(payload?.descriptor);
    if (payload?.approvalId === approvalId || payload?.id === approvalId || descriptor?.id === approvalId) {
      return descriptor;
    }
  }
  return null;
}

function normalizeRisk(value: unknown, fallback?: string): ToolApprovalRequest['risk'] {
  if (typeof value === 'string') return value;
  const risk = recordOf(value);
  if (!risk) return fallback;
  const reasons = Array.isArray(risk.reasons)
    ? risk.reasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  return {
    level: typeof risk.level === 'string' ? risk.level : 'Review',
    summary: typeof risk.summary === 'string' ? risk.summary : fallback,
    reasons,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function Panel({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-7">
          <p className="text-xs font-medium text-accent">TAWX Desktop</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 max-w-2xl text-sm text-surface-500">{description}</p>
        </div>
        <div className="space-y-4">{children}</div>
      </div>
    </div>
  );
}
