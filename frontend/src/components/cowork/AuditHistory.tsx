import { useMemo, useState } from 'react';

export interface AuditEvent {
  id?: string;
  taskId?: string;
  timestamp: number | string;
  kind: string;
  payload: unknown;
}

interface AuditHistoryProps {
  events: AuditEvent[];
  title?: string;
}


function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function eventSummary(event: AuditEvent): string {
  if (!event.payload || typeof event.payload !== 'object') return serialize(event.payload);
  const tool = 'toolName' in event.payload ? event.payload.toolName
    : 'tool' in event.payload ? event.payload.tool
      : 'name' in event.payload ? event.payload.name : undefined;
  const outcome = 'decision' in event.payload ? event.payload.decision
    : 'status' in event.payload ? event.payload.status
      : 'outcome' in event.payload ? event.payload.outcome : undefined;
  const message = 'summary' in event.payload ? event.payload.summary
    : 'message' in event.payload ? event.payload.message : undefined;
  return [tool, outcome, message].filter((value) => typeof value === 'string').join(' · ') || 'Inspect event details';
}

export default function AuditHistory({ events, title = 'Audit history' }: AuditHistoryProps) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const eventKinds = useMemo(() => [...new Set(events.map((event) => event.kind))].sort(), [events]);
  const matchingEvents = useMemo(() => events
    .filter((event) => kind === 'all' || event.kind === kind)
    .filter((event) => normalizedQuery.length === 0
      || `${event.kind}\n${eventSummary(event)}\n${serialize(event)}`.toLocaleLowerCase().includes(normalizedQuery))
    .slice()
    .reverse(), [events, kind, normalizedQuery]);

  return (
    <section className="rounded-2xl border border-surface-200 p-4 dark:border-surface-800" aria-labelledby="audit-history-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="audit-history-title" className="font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-surface-500">Every inspectable event recorded for the active task, including tool calls, decisions, results, diffs, and errors.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-surface-500">
            Event type
            <select value={kind} onChange={(event) => setKind(event.target.value)} className="input mt-1 !w-auto">
              <option value="all">All events</option>
              {eventKinds.map((eventKind) => <option key={eventKind} value={eventKind}>{eventKind.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
          <label className="min-w-56 text-xs font-medium text-surface-500">
            Search audit events
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tool, decision, result…"
              className="input mt-1"
            />
          </label>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {matchingEvents.length === 0 ? (
          <p className="rounded-xl bg-surface-100 px-3 py-4 text-sm text-surface-500 dark:bg-surface-900">
            {events.length === 0 ? 'No task activity has been recorded yet.' : 'No audit events match the current filters.'}
          </p>
        ) : matchingEvents.map((event, index) => (
          <details key={event.id ?? `${event.timestamp}-${event.kind}-${index}`} className="rounded-xl border border-surface-200 px-3 py-2 dark:border-surface-800">
            <summary className="cursor-pointer list-none">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-surface-600 dark:bg-surface-800 dark:text-surface-300">{event.kind.replaceAll('_', ' ')}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{eventSummary(event)}</span>
                <time className="text-xs text-surface-500" dateTime={new Date(event.timestamp).toISOString()}>{new Date(event.timestamp).toLocaleString()}</time>
              </div>
            </summary>
            <pre className="scrollbar-thin mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-100 p-3 text-xs leading-5 dark:bg-surface-900">{serialize(event)}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}
