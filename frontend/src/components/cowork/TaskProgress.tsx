import type { AppMode, TaskStatus, TaskTodo } from '../../types';
import { cn } from '../../lib/utils';
import { IconRefresh, IconSpinner, IconStop } from '../Icons';

interface TaskProgressProps {
  status: TaskStatus;
  todos: readonly TaskTodo[];
  mode: AppMode;
  diffCount?: number;
  artifactCount?: number;
  currentAction?: string;
  contextSummary?: string;
  usageSummary?: string;
  onResume?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onUndo?: () => void | Promise<void>;
}

const statusLabels: Record<TaskStatus, string> = {
  planning: 'Planning',
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const statusStyles: Record<TaskStatus, string> = {
  planning: 'border-sky-400/40 bg-sky-400/10 text-sky-700 dark:text-sky-300',
  running: 'border-accent/40 bg-accent/10 text-accent',
  waiting_approval: 'border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300',
  completed: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300',
  failed: 'border-red-400/40 bg-red-400/10 text-red-700 dark:text-red-300',
  cancelled: 'border-surface-300 bg-surface-100 text-surface-600 dark:border-surface-700 dark:bg-surface-800 dark:text-surface-300',
};

export default function TaskProgress({
  status,
  todos,
  mode,
  diffCount = 0,
  artifactCount = 0,
  currentAction,
  contextSummary,
  usageSummary,
  onResume,
  onCancel,
  onUndo,
}: TaskProgressProps) {
  let completed = 0;
  for (const todo of todos) {
    if (todo.status === 'completed') completed += 1;
  }
  const active = status === 'planning' || status === 'running' || status === 'waiting_approval';
  const percent = todos.length === 0 ? (status === 'completed' ? 100 : 0) : Math.round((completed / todos.length) * 100);

  const meta: string[] = [];
  if (todos.length > 0) meta.push(`${completed}/${todos.length} steps`);
  if (mode === 'code' && diffCount > 0) meta.push(`${diffCount} ${diffCount === 1 ? 'diff' : 'diffs'}`);
  if (artifactCount > 0) meta.push(`${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'}`);
  if (contextSummary) meta.push(contextSummary);
  if (usageSummary) meta.push(usageSummary);

  return (
    <section className="rounded-xl border border-surface-200 bg-surface-50/80 px-3 py-2 shadow-sm dark:border-surface-800 dark:bg-surface-900/70" aria-label="Task progress">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h2 className="text-sm font-semibold">{mode === 'code' ? 'Code execution' : 'Task execution'}</h2>
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', statusStyles[status])}>
            {(status === 'planning' || status === 'running') && <IconSpinner className="h-3 w-3" />}
            {statusLabels[status]}
          </span>
          {meta.length > 0 && (
            <span className="min-w-0 truncate text-xs text-surface-500">{meta.join(' · ')}</span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {onUndo && diffCount > 0 && !active && (
            <button type="button" onClick={() => void onUndo()} className="btn-ghost border border-surface-200 dark:border-surface-700">
              Undo last change
            </button>
          )}
          {onResume && status !== 'completed' && (
            <button type="button" onClick={() => void onResume()} className="btn-primary">
              <IconRefresh className="h-4 w-4" />
              Resume
            </button>
          )}
          {onCancel && active && (
            <button type="button" onClick={() => void onCancel()} className="btn-ghost border border-surface-200 text-red-600 dark:border-surface-700 dark:text-red-300">
              <IconStop className="h-4 w-4" />
              Cancel safely
            </button>
          )}
        </div>
      </div>

      {currentAction && (
        <p className="mt-1.5 truncate text-xs text-surface-600 dark:text-surface-300">
          Current action <code className="rounded bg-surface-100 px-1.5 py-0.5 dark:bg-surface-800">{currentAction}</code>
        </p>
      )}

      {todos.length > 0 && (
        <div className="mt-2" aria-label={`${percent}% complete`}>
          <div className="h-1 overflow-hidden rounded-full bg-surface-200 dark:bg-surface-800">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}

      {todos.length > 0 && (
        <ol className="mt-2.5 space-y-2">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-start gap-2 text-sm">
              <span
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]',
                  todo.status === 'completed' && 'border-emerald-500 bg-emerald-500 text-white',
                  todo.status === 'in_progress' && 'border-accent text-accent',
                  todo.status === 'pending' && 'border-surface-300 text-transparent dark:border-surface-700',
                  (todo.status === 'failed' || todo.status === 'cancelled') && 'border-red-400 text-red-500',
                )}
                aria-hidden
              >
                {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '•' : todo.status === 'failed' || todo.status === 'cancelled' ? '×' : ''}
              </span>
              <span className={cn('min-w-0', todo.status === 'completed' && 'text-surface-400 line-through')}>
                {todo.text}
                {todo.detail && <span className="mt-0.5 block text-xs text-surface-500">{todo.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {status === 'failed' && (
        <p className="mt-1.5 text-xs text-surface-500">Execution stopped after an error. Completed steps and the execution record remain available.</p>
      )}
      {status === 'cancelled' && (
        <p className="mt-1.5 text-xs text-surface-500">Execution was cancelled. Its transcript remains available.</p>
      )}
    </section>
  );
}
