import { useState } from 'react';

export type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export interface ToolApprovalRequest {
  id: string;
  taskId?: string;
  toolName: string;
  input: unknown;
  risk?: string | {
    level?: string;
    summary?: string;
    reasons?: string[];
  };
  diff?: string | null;
  requestedAt?: number | string;
}

interface ApprovalRequestCardProps {
  approval: ToolApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void | Promise<void>;
  disabled?: boolean;
}

const decisionLabels: Record<ApprovalDecision, string> = {
  deny: 'Deny',
  allow_once: 'Allow once',
  allow_session: 'Allow session',
};

function prettyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

function riskDetails(risk: ToolApprovalRequest['risk']): { level: string; summary: string; reasons: string[] } {
  if (!risk) return { level: 'Review', summary: 'Review this tool call before it runs.', reasons: [] };
  if (typeof risk === 'string') return { level: risk, summary: risk, reasons: [] };
  return {
    level: risk.level ?? 'Review',
    summary: risk.summary ?? 'Review this tool call before it runs.',
    reasons: risk.reasons ?? [],
  };
}

export default function ApprovalRequestCard({ approval, onDecision, disabled = false }: ApprovalRequestCardProps) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const risk = riskDetails(approval.risk);

  const decide = async (decision: ApprovalDecision) => {
    setSubmitting(decision);
    setError(null);
    try {
      await onDecision(decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit the approval decision.');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <article className="rounded-2xl border border-amber-400/40 bg-amber-400/5 p-4" aria-label={`Approval required for ${approval.toolName}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Approval required</p>
          <h3 className="mt-1 break-all font-semibold">{approval.toolName}</h3>
          {approval.requestedAt && (
            <time className="mt-1 block text-xs text-surface-500" dateTime={new Date(approval.requestedAt).toISOString()}>
              {new Date(approval.requestedAt).toLocaleString()}
            </time>
          )}
        </div>
        <span className="rounded-full border border-amber-400/40 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          {risk.level}
        </span>
      </div>

      <div className="mt-4 space-y-3 text-sm">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-surface-500">Risk</h4>
          <p className="mt-1 leading-6">{risk.summary}</p>
          {risk.reasons.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-surface-500">
              {risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </section>
        <details open>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-surface-500">Full input</summary>
          <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-100 p-3 text-xs leading-5 dark:bg-surface-900">{prettyInput(approval.input)}</pre>
        </details>
        {approval.diff && (
          <details open>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-surface-500">Proposed diff</summary>
            <pre className="scrollbar-thin mt-2 max-h-80 overflow-auto whitespace-pre rounded-xl bg-surface-950 p-3 text-xs leading-5 text-surface-100">{approval.diff}</pre>
          </details>
        )}
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {(['deny', 'allow_once', 'allow_session'] as const).map((decision) => (
          <button
            key={decision}
            type="button"
            disabled={disabled || submitting !== null}
            onClick={() => void decide(decision)}
            className={decision === 'deny' ? 'btn-ghost border border-surface-200 dark:border-surface-700' : 'btn-primary'}
          >
            {submitting === decision ? 'Submitting…' : decisionLabels[decision]}
          </button>
        ))}
      </div>
    </article>
  );
}
