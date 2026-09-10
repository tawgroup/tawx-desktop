import { useEffect, useRef, type KeyboardEvent, type WheelEvent } from 'react';
import { distanceFromBottom, isUpwardKey, shouldFollow } from '../lib/autoscroll.ts';
import { useChats } from '../store/useChats';
import MessageBubble from './MessageBubble';
import { IconLock, IconRefresh } from './Icons';
import type { AppMode, TaskApproval } from '../types';
import ApprovalRequestCard, { type ToolApprovalRequest } from './cowork/ApprovalRequestCard';
import TaskProgress from './cowork/TaskProgress';
import TaskTimeline from './cowork/TaskTimeline';

const taskStarters = [
  ['Research and report', 'Research this topic, keep the evidence visible, and deliver a concise report with sources.'],
  ['Create a deliverable', 'Turn these notes into a finished deliverable, checking the result before you hand it back.'],
  ['Organize a project', 'Inspect this workspace and organize the project around a clear outcome.'],
  ['Plan and execute', 'Break this outcome into steps, work through them, and report what changed.'],
] as const;

const codeStarters = [
  ['Inspect the codebase', 'Inspect this repository, trace the relevant execution path, and explain what you find.'],
  ['Make a focused change', 'Implement the requested behavior with the smallest safe edit, then show me the diff.'],
  ['Debug and verify', 'Reproduce this problem, fix its cause, and run the focused check that proves the fix.'],
  ['Review a diff', 'Inspect the current git diff for correctness, security, and unnecessary complexity.'],
] as const;

function approvalRequest(taskId: string, approval: TaskApproval): ToolApprovalRequest {
  const candidate = approval.arguments !== null && typeof approval.arguments === 'object' && !Array.isArray(approval.arguments)
    ? approval.arguments as Record<string, unknown>
    : {};
  const descriptor = 'capability' in candidate || 'risk' in candidate || 'title' in candidate || 'detail' in candidate
    ? candidate
    : {};
  const rawRisk = descriptor.risk;
  let risk: ToolApprovalRequest['risk'];
  if (typeof rawRisk === 'string') {
    risk = rawRisk;
  } else if (rawRisk !== null && typeof rawRisk === 'object' && !Array.isArray(rawRisk)) {
    const value = rawRisk as Record<string, unknown>;
    risk = {
      level: typeof value.level === 'string' ? value.level : undefined,
      summary: typeof value.summary === 'string' ? value.summary : approval.reason,
      reasons: Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === 'string')
        ? value.reasons as string[]
        : undefined,
    };
  } else if (approval.reason) {
    risk = { summary: approval.reason };
  }

  return {
    id: approval.id,
    taskId,
    toolName: typeof descriptor.tool === 'string' ? descriptor.tool : approval.tool,
    input: 'input' in descriptor ? descriptor.input : approval.arguments,
    risk,
    diff: typeof descriptor.diff === 'string' ? descriptor.diff : undefined,
    requestedAt: approval.requestedAt,
  };
}

export default function ChatView({ mode }: { mode: AppMode }) {
  const messages = useChats((s) => s.messages);
  const streaming = useChats((s) => s.streaming);
  const streamingId = useChats((s) => s.streamingId);
  const regenerate = useChats((s) => s.regenerate);
  const reanalyzeVision = useChats((s) => s.reanalyzeVision);
  const activeChatId = useChats((s) => s.activeChatId);
  const activeTask = useChats((s) => s.activeTask);
  const send = useChats((s) => s.send);
  const resumeTask = useChats((s) => s.resumeTask);
  const cancelTask = useChats((s) => s.cancelTask);
  const respondToApproval = useChats((s) => s.respondToApproval);
  const undoTask = useChats((s) => s.undoTask);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const task = mode === 'chat' ? null : activeTask;
  let activeDiffCount = 0;
  if (task) {
    for (const diff of task.diffs) {
      if (!diff.undone) activeDiffCount += 1;
    }
  }
  const currentTool = task?.toolCalls.findLast((toolCall) => toolCall.status === 'running' || toolCall.status === 'waiting_approval');
  const eventCount = task?.events.length ?? 0;
  const taskActive = task !== null && (task.status === 'planning' || task.status === 'running' || task.status === 'waiting_approval');

  /** Scrolls the transcript itself, not every scrollable ancestor. */
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = shouldFollow({ distance: distanceFromBottom(el) });
  };

  // Gestures are handled separately from `scroll` because they are synchronous:
  // waiting for the scroll event lets a streamed token re-pin first and cancel
  // the reader's own scroll.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = shouldFollow({ distance: distanceFromBottom(el), gestureDeltaY: event.deltaY });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isUpwardKey(event.key)) return;
    pinned.current = false;
  };

  useEffect(() => {
    if (pinned.current) scrollToBottom();
  }, [messages, eventCount]);

  useEffect(() => {
    pinned.current = true;
    scrollToBottom();
  }, [activeChatId]);

  const canRegenerate =
    mode === 'chat' && !streaming && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

  if (messages.length === 0 && !task) {
    if (mode !== 'chat') {
      const code = mode === 'code';
      const starters = code ? codeStarters : taskStarters;
      return (
        <div className="scrollbar-thin flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
          <div className="w-full max-w-2xl">
            <p className="mb-2 text-center text-sm font-medium text-accent">{code ? 'Code' : 'Cowork'}</p>
            <h1 className="text-center text-3xl font-semibold tracking-tight text-surface-800 dark:text-surface-100">
              {code ? 'What should change in this workspace?' : 'What outcome should the agent deliver?'}
            </h1>
            <p className="mx-auto mt-3 max-w-lg text-center text-sm leading-6 text-surface-500">
              {code
                ? 'Describe the expected behavior and constraints. The execution record will keep checks and changes reviewable.'
                : 'Describe the result you need. You can follow the work, review decisions, and inspect the deliverables as it runs.'}
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {starters.map(([title, prompt]) => (
                <button
                  key={title}
                  type="button"
                  onClick={() => void send(prompt, undefined, mode)}
                  className="rounded-2xl border border-surface-200 bg-surface-50 p-4 text-left transition-colors
                             hover:border-surface-300 hover:bg-surface-100 dark:border-surface-800
                             dark:bg-surface-900 dark:hover:border-surface-700 dark:hover:bg-surface-800"
                >
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="mt-1.5 block text-xs leading-5 text-surface-500">{prompt}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 grid grid-cols-4 overflow-hidden rounded-xl border border-surface-200 text-center text-[11px] text-surface-500 dark:border-surface-800">
              {(code ? ['Inspect', 'Edit', 'Check', 'Deliver'] : ['Scope', 'Plan', 'Execute', 'Review']).map((step, index) => (
                <div key={step} className="border-r border-surface-200 px-2 py-2.5 last:border-r-0 dark:border-surface-800">
                  <span className="mr-1 text-accent">{index + 1}</span>{step}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <p className="mb-2 text-sm font-medium text-accent">Chat</p>
          <h1 className="mb-3 text-2xl font-semibold text-surface-800 dark:text-surface-100">What can I help with?</h1>
          <p className="mb-6 text-sm text-surface-500 dark:text-surface-400">
            Ask a question, explore an idea, or work through a decision together.
          </p>
          <p className="inline-flex items-center gap-2 rounded-full bg-surface-100 px-3 py-1.5 text-xs text-surface-500 dark:bg-surface-800 dark:text-surface-400">
            <IconLock className="h-3.5 w-3.5" />
            Conversation history is stored locally
          </p>
        </div>
      </div>
    );
  }

  let contextSummary: string | undefined;
  if (task?.context.maxTokens) {
    contextSummary = `${Math.round((task.context.usedTokens / task.context.maxTokens) * 100)}% context`;
  }
  if (task && task.context.compactionCount > 0) {
    contextSummary = `${contextSummary ? `${contextSummary} · ` : ''}${task.context.compactionCount} ${task.context.compactionCount === 1 ? 'compaction' : 'compactions'}`;
  }
  let usageSummary = task && task.usage.totalTokens > 0
    ? `${task.usage.totalTokens.toLocaleString()} tokens`
    : undefined;
  if (usageSummary && task?.usage.cost !== undefined) usageSummary += ` · $${task.usage.cost.toFixed(4)}`;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      className="scrollbar-thin flex-1 overflow-y-auto [overflow-anchor:none]"
    >
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isStreaming={streaming && message.id === streamingId}
          visionCost={message.role === 'assistant'
            ? messages.findLast((candidate) => candidate.role === 'user' && candidate.createdAt < message.createdAt)?.visionAnalysis?.cost
            : undefined}
          onReanalyzeVision={!streaming && message.visionAnalysis
            ? () => void reanalyzeVision(message.id)
            : undefined}
        />
      ))}

      {task && (
        <div className="mx-auto max-w-3xl space-y-3 px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-surface-500">
            {task.workspace && (
              <span className="min-w-0 truncate" title={task.workspace.path}>
                Workspace <strong className="font-medium text-surface-700 dark:text-surface-300">{task.workspace.name}</strong>
              </span>
            )}
            <span>Policy <strong className="font-medium text-surface-700 dark:text-surface-300">{task.policy}</strong></span>
            {task.enabledTools.length > 0 && (
              <details className="relative">
                <summary className="cursor-pointer select-none">{task.enabledTools.length} enabled {task.enabledTools.length === 1 ? 'tool' : 'tools'}</summary>
                <div className="absolute bottom-full left-0 z-10 mb-2 min-w-44 rounded-lg border border-surface-200 bg-white p-2 shadow-lg dark:border-surface-700 dark:bg-surface-900">
                  {task.enabledTools.map((tool) => <code key={tool} className="block py-0.5 text-[11px]">{tool}</code>)}
                </div>
              </details>
            )}
          </div>

          <TaskProgress
            status={task.status}
            todos={task.todos}
            mode={mode}
            diffCount={activeDiffCount}
            currentAction={currentTool?.name}
            artifactCount={task.artifacts.length}
            contextSummary={contextSummary}
            usageSummary={usageSummary}
            onResume={!streaming && taskActive ? () => resumeTask(task.id) : undefined}
            onCancel={taskActive ? () => cancelTask(task.id) : undefined}
            onUndo={activeDiffCount > 0 && !taskActive ? () => undoTask(task.id) : undefined}
          />

          {task.approvals.map((approval) => approval.status !== 'pending' ? null : (
            <ApprovalRequestCard
              key={approval.id}
              approval={approvalRequest(task.id, approval)}
              onDecision={(decision) => respondToApproval(approval.id, decision, task.id)}
            />
          ))}

          {task.error && (
            <div role="alert" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              <p className="font-medium">Task failed</p>
              <p className="mt-1 whitespace-pre-wrap">{task.error}</p>
            </div>
          )}

          <TaskTimeline events={task.events} approvals={task.approvals} diffs={task.diffs} mode={mode} />
        </div>
      )}

      {canRegenerate && (
        <div className="flex justify-center py-4">
          <button onClick={() => void regenerate()} className="btn-ghost border border-surface-200 dark:border-surface-700">
            <IconRefresh className="h-4 w-4" />
            Regenerate
          </button>
        </div>
      )}

      <div className="h-4" />
    </div>
  );
}
