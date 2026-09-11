import type { AppMode, TaskApproval, TaskEvent, TaskFileDiff } from '../../types';
import { cn, formatTime } from '../../lib/utils';

interface TaskTimelineProps {
  events: readonly TaskEvent[];
  approvals: readonly TaskApproval[];
  diffs: readonly TaskFileDiff[];
  mode: AppMode;
}

const eventLabels: Record<string, string> = {
  status: 'Status changed',
  todo: 'Plan updated',
  tool_call: 'Tool requested',
  approval_required: 'Approval requested',
  tool_result: 'Tool finished',
  file_diff: 'Changes recorded',
  artifact: 'Artifact created',
  context: 'Context updated',
  usage: 'Usage updated',
  done: 'Task completed',
  error: 'Task failed',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function printable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre rounded-xl border border-surface-200 bg-surface-950 p-3 font-mono text-xs leading-5 text-surface-200 dark:border-surface-800">
      {diff}
    </pre>
  );
}

function Payload({ value, label = 'Details' }: { value: unknown; label?: string }) {
  const text = printable(value);
  if (!text) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-surface-500 hover:text-surface-700 dark:hover:text-surface-300">{label}</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-100 p-3 text-xs leading-5 text-surface-700 dark:bg-surface-950 dark:text-surface-300">{text}</pre>
    </details>
  );
}

function TodoEvent({ payload }: { payload: Record<string, unknown> }) {
  const rawItems = Array.isArray(payload.todos) ? payload.todos : Array.isArray(payload.items) ? payload.items : [];
  if (rawItems.length === 0) return <Payload value={payload} />;

  return (
    <ul className="mt-2 space-y-1.5 text-xs text-surface-600 dark:text-surface-300">
      {rawItems.map((item, index) => {
        const todo = asRecord(item);
        const title = stringValue(todo.title) ?? stringValue(todo.text) ?? `Step ${index + 1}`;
        const status = stringValue(todo.status);
        return (
          <li key={stringValue(todo.id) ?? `${index}-${title}`} className="flex items-start gap-2">
            <span className="mt-px text-surface-400" aria-hidden>{status === 'completed' ? '✓' : status === 'in_progress' ? '●' : status === 'failed' || status === 'cancelled' ? '×' : '○'}</span>
            <span>{title}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ArtifactEvent({ payload }: { payload: Record<string, unknown> }) {
  const artifact = payload.artifact !== null && typeof payload.artifact === 'object' && !Array.isArray(payload.artifact)
    ? asRecord(payload.artifact)
    : payload;
  const name = stringValue(artifact.name) ?? stringValue(artifact.title) ?? stringValue(artifact.path) ?? 'Artifact';
  const path = stringValue(artifact.path);
  const url = stringValue(artifact.url);
  const description = stringValue(artifact.description) ?? stringValue(artifact.mimeType) ?? stringValue(artifact.type);
  const size = typeof artifact.size === 'number' ? artifact.size : undefined;
  const content = artifact.content;
  const link = url && (url.startsWith('/') || url.startsWith('http://') || url.startsWith('https://')) ? url : undefined;

  return (
    <div className="mt-2 rounded-xl border border-surface-200 bg-surface-50 px-3 py-2.5 text-sm dark:border-surface-800 dark:bg-surface-950/40">
      {link ? (
        <a href={link} target="_blank" rel="noreferrer noopener" className="font-medium text-accent underline decoration-transparent underline-offset-2 hover:decoration-current">{name}</a>
      ) : (
        <span className="font-medium">{name}</span>
      )}
      {(description || size !== undefined) && (
        <p className="mt-0.5 text-xs text-surface-500">
          {description}{description && size !== undefined ? ' · ' : ''}{size !== undefined ? `${size.toLocaleString()} bytes` : ''}
        </p>
      )}
      {path && path !== name && <code className="mt-1 block break-all text-xs text-surface-500">{path}</code>}
      {content !== undefined && <Payload value={content} label="Preview" />}
    </div>
  );
}

function EventBody({
  event,
  mode,
  approvals,
  diffs,
}: {
  event: TaskEvent;
  mode: AppMode;
  approvals: readonly TaskApproval[];
  diffs: readonly TaskFileDiff[];
}) {
  const payload = asRecord(event.payload);
  const name = stringValue(payload.name) ?? stringValue(payload.toolName);

  switch (event.kind) {
    case 'status':
      return <p className="mt-1 text-sm text-surface-600 dark:text-surface-300">{stringValue(payload.message) ?? stringValue(payload.state) ?? 'Task state updated'}</p>;
    case 'todo':
      return <TodoEvent payload={payload} />;
    case 'tool_call':
      return (
        <>
          <p className="mt-1 text-sm"><code className="rounded bg-surface-100 px-1.5 py-0.5 text-xs dark:bg-surface-800">{name ?? 'Tool'}</code> started</p>
          <Payload value={payload.arguments ?? payload.input} label="Input" />
        </>
      );
    case 'approval_required': {
      const approvalId = stringValue(payload.approvalId);
      const approval = approvalId ? approvals.find((candidate) => candidate.id === approvalId) : undefined;
      let decision: string | undefined;
      if (approval?.decision === 'allow_once') decision = 'Allowed once';
      else if (approval?.decision === 'allow_session') decision = 'Allowed for this session';
      else if (approval?.decision === 'deny' || approval?.status === 'denied') decision = 'Denied';
      else if (approval?.status === 'allowed') decision = 'Allowed';
      return (
        <p className={cn('mt-1 text-sm', decision ? 'text-surface-600 dark:text-surface-300' : 'text-amber-700 dark:text-amber-300')}>
          {decision ?? 'Review required'} for <code>{name ?? approval?.tool ?? 'this action'}</code>.
        </p>
      );
    }
    case 'tool_result': {
      const ok = payload.ok !== false && !payload.error;
      const output = payload.error ?? payload.output ?? payload.result;
      return (
        <>
          <p className={cn('mt-1 text-sm', ok ? 'text-surface-600 dark:text-surface-300' : 'text-red-700 dark:text-red-300')}>
            <code>{name ?? 'Tool'}</code> {ok ? 'finished' : 'failed'}
          </p>
          <Payload value={output} label={ok ? 'Output' : 'Error'} />
          {stringValue(payload.checkpointId) && <p className="mt-2 text-[11px] text-surface-400">Checkpoint {stringValue(payload.checkpointId)}</p>}
        </>
      );
    }
    case 'file_diff': {
      const diffId = stringValue(payload.id) ?? stringValue(payload.checkpointId) ?? event.id;
      const recorded = diffs.find((candidate) => candidate.id === diffId);
      const diff = stringValue(payload.diff) ?? stringValue(payload.patch) ?? recorded?.diff;
      const path = stringValue(payload.path) ?? stringValue(payload.file) ?? recorded?.path;
      return diff ? (
        <details open={mode === 'code'} className={cn('mt-1', recorded?.undone && 'opacity-70')}>
          <summary className="cursor-pointer select-none text-sm font-medium text-surface-600 hover:text-surface-900 dark:text-surface-300 dark:hover:text-white">
            {recorded?.undone ? 'Undone · ' : ''}{path && path !== 'workspace' ? `${path} · ` : ''}{mode === 'code' ? 'Inspect git-style diff' : 'Inspect changes'}
          </summary>
          <Diff diff={diff} />
        </details>
      ) : <Payload value={payload} />;
    }
    case 'artifact':
      return <ArtifactEvent payload={payload} />;
    case 'error':
      return <p role="alert" className="mt-1 whitespace-pre-wrap text-sm text-red-700 dark:text-red-300">{stringValue(payload.message) ?? printable(payload)}</p>;
    case 'done':
      return <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-300">Execution finished successfully.</p>;
    case 'context':
      return <Payload value={payload} label="Context details" />;
    case 'usage':
      return <Payload value={payload} label="Usage details" />;
    default:
      return <Payload value={payload} />;
  }
}

export default function TaskTimeline({ events, mode, approvals, diffs }: TaskTimelineProps) {
  let visibleEventCount = 0;
  for (const event of events) {
    if (event.kind !== 'assistant_delta' && event.kind !== 'reasoning_delta') visibleEventCount += 1;
  }

  return (
    <details
      className="rounded-xl border border-surface-200 px-3 py-2 dark:border-surface-700"
      aria-label="Execution transcript"
    >
      <summary
        className="cursor-pointer select-none text-sm text-surface-500 dark:text-surface-400"
        title="Lifecycle, tool activity, outputs, and deliverables"
      >
        Execution transcript
        <span className="ml-1.5 text-xs text-surface-400">
          {visibleEventCount} {visibleEventCount === 1 ? 'event' : 'events'}
        </span>
      </summary>

      {visibleEventCount === 0 ? (
        <p className="mt-3 rounded-xl bg-surface-50 px-3 py-4 text-center text-sm text-surface-500 dark:bg-surface-950/40">Waiting for the first execution event.</p>
      ) : (
        <ol className="relative ml-2 mt-4 border-l border-surface-200 pl-5 dark:border-surface-800">
          {events.map((event) => {
            if (event.kind === 'assistant_delta' || event.kind === 'reasoning_delta') return null;
            const payload = asRecord(event.payload);
            const timestamp = formatTime(event.timestamp);
            const failed = event.kind === 'error' || (event.kind === 'tool_result' && (payload.ok === false || Boolean(payload.error)));
            return (
              <li key={`${event.taskId}-${event.id}`} className="relative pb-5 last:pb-0">
                <span
                  className={cn(
                    'absolute -left-[25px] top-1.5 h-2 w-2 rounded-full ring-4 ring-white dark:ring-surface-900',
                    failed ? 'bg-red-500' : event.kind === 'done' ? 'bg-emerald-500' : event.kind === 'approval_required' ? 'bg-amber-500' : 'bg-surface-400',
                  )}
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold text-surface-700 dark:text-surface-200">{eventLabels[event.kind] ?? event.kind.replaceAll('_', ' ')}</h3>
                  {timestamp && <time className="text-[11px] text-surface-400">{timestamp}</time>}
                </div>
                <EventBody event={event} mode={mode} approvals={approvals} diffs={diffs} />
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}
