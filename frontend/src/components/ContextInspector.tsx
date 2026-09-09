import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { IconCheck, IconClose, IconCopy } from './Icons';
import {
  buildEffectiveModelSystemPrompt,
  estimateSystemPromptTokens,
  expandSkillInstructions,
  resolveSelectedSkills,
  type ResolvedSkillContext,
} from './contextInspection';

export interface InspectedContextItem {
  id: string;
  name: string;
  kind: 'file' | 'image' | 'project';
  mediaType?: string;
  size?: number;
  text?: string;
  imageUrl?: string;
  source?: string;
}

export interface ContextInspection {
  threadId: string | null;
  threadTitle: string;
  systemPrompt: string;
  mode: 'chat' | 'cowork' | 'code';
  systemPromptSource: 'new-thread default' | 'new-thread draft' | 'thread snapshot' | 'legacy default' | 'none';
  workspace: { path: string; name?: string } | null;
  includedItems: InspectedContextItem[];
  enabledTools: string[];
  enabledSkills: string[];
  policy: string;
  tokenUsage: {
    used: number | null;
    budget: number | null;
    remaining: number | null;
    compactedMessages: number;
    compactionCount: number;
    measuredAt?: number;
    lastCompactedAt?: number;
    summary?: string;
  };
  request: Record<string, unknown>;
  requestStage: 'chat' | 'desktop-task';
  taskStatus?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  inspection: ContextInspection;
}

type SkillResolutionState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; context: ResolvedSkillContext }
  | { status: 'error'; key: string; message: string };

const POLICY_DESCRIPTIONS: Record<string, string> = {
  plan: 'Read-only planning. Commands and mutations are denied.',
  ask: 'Reads run directly; writes, commands, Git, browser, and MCP actions require approval.',
  allow: 'Enabled safe tools can run directly. Destructive Git and workspace escape stay denied.',
};

function formatBytes(size?: number) {
  if (size === undefined) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-surface-200 p-4 dark:border-surface-700">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function ContextInspector({ open, onClose, inspection }: Props) {
  const [copied, setCopied] = useState(false);
  const [skillResolution, setSkillResolution] = useState<SkillResolutionState>({ status: 'idle' });
  const serializedRequest = useMemo(
    () => open ? (JSON.stringify(inspection.request, null, 2) ?? '') : '',
    [inspection.request, open],
  );
  const skillResolutionKey = JSON.stringify([
    inspection.requestStage,
    inspection.workspace?.path ?? null,
    inspection.enabledSkills,
  ]);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);
  useEffect(() => {
    if (!open) return;
    if (inspection.requestStage === 'chat' || inspection.enabledSkills.length === 0) {
      setSkillResolution({
        status: 'ready',
        key: skillResolutionKey,
        context: { skills: [], unavailableSkillIds: [], failedSkills: [] },
      });
      return;
    }
    const controller = new AbortController();
    setSkillResolution({ status: 'loading', key: skillResolutionKey });
    void resolveSelectedSkills(
      inspection.enabledSkills,
      inspection.workspace?.path,
      controller.signal,
    ).then((context) => {
      if (!controller.signal.aborted) {
        setSkillResolution({ status: 'ready', key: skillResolutionKey, context });
      }
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || cause instanceof DOMException && cause.name === 'AbortError') return;
      setSkillResolution({
        status: 'error',
        key: skillResolutionKey,
        message: cause instanceof Error ? cause.message : 'Could not resolve selected skills.',
      });
    });
    return () => controller.abort();
  }, [inspection.enabledSkills, inspection.requestStage, inspection.workspace?.path, open, skillResolutionKey]);

  const currentSkillResolution: SkillResolutionState = skillResolution.status !== 'idle'
    && skillResolution.key === skillResolutionKey
    ? skillResolution
    : { status: 'idle' };
  const resolvedSkillContext = inspection.requestStage === 'desktop-task'
    && currentSkillResolution.status === 'ready'
    ? currentSkillResolution.context
    : null;
  const skillExpansion = useMemo(
    () => expandSkillInstructions(resolvedSkillContext?.skills ?? []),
    [resolvedSkillContext],
  );
  const effectivePromptKnown = inspection.requestStage === 'chat'
    || inspection.enabledSkills.length === 0
    || Boolean(resolvedSkillContext && resolvedSkillContext.failedSkills.length === 0);
  const effectiveSystemPrompt = useMemo(
    () => effectivePromptKnown
      ? buildEffectiveModelSystemPrompt(inspection.systemPrompt, skillExpansion.prompt)
      : inspection.systemPrompt,
    [effectivePromptKnown, inspection.systemPrompt, skillExpansion.prompt],
  );
  const runtimeSkillTokens = effectivePromptKnown
    ? Math.max(
        0,
        estimateSystemPromptTokens(effectiveSystemPrompt)
          - estimateSystemPromptTokens(inspection.systemPrompt.trim()),
      )
    : null;

  if (!open) return null;

  const { tokenUsage } = inspection;
  const tokenPercent = tokenUsage.used !== null && tokenUsage.budget
    ? Math.min(100, Math.round((tokenUsage.used / tokenUsage.budget) * 100))
    : null;
  const effectiveTokenEstimate = tokenUsage.used !== null && runtimeSkillTokens !== null
    ? tokenUsage.used + runtimeSkillTokens
    : null;
  const effectiveTokenPercent = effectiveTokenEstimate !== null && tokenUsage.budget
    ? Math.round((effectiveTokenEstimate / tokenUsage.budget) * 100)
    : null;

  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(serializedRequest);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = serializedRequest;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } finally {
        textarea.remove();
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-inspector-title"
        className="relative flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl dark:bg-surface-800"
      >
        <header className="safe-top flex shrink-0 items-start justify-between gap-4 border-b border-surface-100 px-5 py-4 dark:border-surface-700">
          <div className="min-w-0">
            <h2 id="context-inspector-title" className="text-lg font-semibold">Model context</h2>
            <p className="mt-0.5 truncate text-xs text-surface-500">
              {inspection.threadTitle} · {inspection.threadId ?? 'not saved yet'}
              {inspection.taskStatus ? ` · ${inspection.taskStatus}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost !px-2" aria-label="Close context inspector">
            <IconClose />
          </button>
        </header>

        <div className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <p className="text-sm leading-6 text-surface-600 dark:text-surface-300">
            This is the inspectable context for the next model turn. {inspection.requestStage === 'desktop-task'
              ? 'The effective prompt below includes runtime skill expansion; the raw pre-runtime request remains visible at the bottom.'
              : 'The request at the bottom is the exact provider body.'} Provider credentials are not model context and are excluded.
          </p>
          {!inspection.threadId && (
            <p className="rounded-lg bg-surface-50 px-3 py-2 text-xs leading-5 text-surface-500 dark:bg-surface-900">
              The app creates a thread id on first send. It is not model context; where a desktop
              task request needs it, the preview marks that one dynamic value. Skill resolution
              status below shows when the effective context is final.
            </p>
          )}

          <Section title="Effective model system prompt">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="rounded-full bg-surface-100 px-2 py-1 text-[11px] font-medium text-surface-600 dark:bg-surface-900 dark:text-surface-300">
                {inspection.systemPromptSource}{inspection.mode === 'code' ? ' + Code mode' : ''}
              </span>
              <span className="text-xs text-surface-500">
                {effectivePromptKnown ? `${effectiveSystemPrompt.length.toLocaleString()} characters` : 'Waiting for skill resolution'}
              </span>
            </div>
            {currentSkillResolution.status === 'loading' && (
              <p role="status" className="mb-3 rounded-lg bg-surface-50 px-3 py-2 text-xs text-surface-500 dark:bg-surface-900">
                Resolving selected SKILL.md instructions from the desktop runtime…
              </p>
            )}
            {currentSkillResolution.status === 'error' && (
              <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
                Effective prompt unavailable: {currentSkillResolution.message}
              </p>
            )}
            {resolvedSkillContext?.failedSkills.length ? (
              <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
                Effective prompt unavailable because {resolvedSkillContext.failedSkills.length} selected skill
                {resolvedSkillContext.failedSkills.length === 1 ? '' : 's'} could not be loaded.
              </p>
            ) : null}
            {effectivePromptKnown ? effectiveSystemPrompt ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-3 text-xs leading-5 text-surface-100">
                {effectiveSystemPrompt}
              </pre>
            ) : (
              <p className="text-sm text-surface-500">No system prompt will be sent.</p>
            ) : inspection.systemPrompt ? (
              <>
                <p className="mb-2 text-xs leading-5 text-surface-500">
                  Showing the pre-skill prompt only. It is not the complete model prompt.
                </p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-3 text-xs leading-5 text-surface-100">
                  {inspection.systemPrompt}
                </pre>
              </>
            ) : null}
            {inspection.requestStage === 'desktop-task' && inspection.enabledSkills.length > 0 && effectivePromptKnown && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-surface-500">Pre-runtime base prompt</summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-50 p-3 text-xs leading-5 dark:bg-surface-900">
                  {inspection.systemPrompt || '(empty)'}
                </pre>
              </details>
            )}
          </Section>

          <Section title="Workspace">
            {inspection.workspace ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
                <dt className="text-surface-500">Name</dt>
                <dd>{inspection.workspace.name || 'Unnamed workspace'}</dd>
                <dt className="text-surface-500">Path</dt>
                <dd className="break-all font-mono text-xs leading-5">{inspection.workspace.path}</dd>
              </dl>
            ) : (
              <p className="text-sm text-surface-500">No workspace is attached to this thread.</p>
            )}
          </Section>

          <Section title={`Included files and attachments (${inspection.includedItems.length})`}>
            {inspection.includedItems.length ? (
              <div className="space-y-2">
                {inspection.includedItems.map((item) => (
                  <details key={item.id} className="rounded-lg bg-surface-50 px-3 py-2 dark:bg-surface-900">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{item.name}</p>
                          <p className="mt-0.5 text-xs text-surface-500">
                            {[item.kind, item.mediaType, formatBytes(item.size), item.source].filter(Boolean).join(' · ')}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-surface-500">Inspect</span>
                      </div>
                    </summary>
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.name} className="mt-3 max-h-72 rounded-lg object-contain" />
                    ) : item.text !== undefined ? (
                      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-3 text-xs leading-5 text-surface-100">
                        {item.text}
                      </pre>
                    ) : (
                      <p className="mt-3 text-xs text-surface-500">Content is represented in the exact request below.</p>
                    )}
                  </details>
                ))}
              </div>
            ) : (
              <p className="text-sm text-surface-500">No files or attachments are included.</p>
            )}
          </Section>

          <Section title={`Selected skill instructions (${inspection.enabledSkills.length})`}>
            {inspection.requestStage === 'desktop-task' && inspection.enabledSkills.length > 0 && (
              <p className="mb-3 text-xs leading-5 text-surface-500">
                Skills are read from disk when a task starts. This view resolves the current files;
                edits made before send will change the runtime prompt.
              </p>
            )}
            {inspection.requestStage === 'chat' ? (
              <p className="text-sm text-surface-500">
                Ordinary Chat does not send developer-agent skill instructions.
              </p>
            ) : inspection.enabledSkills.length === 0 ? (
              <p className="text-sm text-surface-500">No skill instructions are included.</p>
            ) : currentSkillResolution.status === 'loading' || currentSkillResolution.status === 'idle' ? (
              <p role="status" className="text-sm text-surface-500">Loading selected SKILL.md files…</p>
            ) : currentSkillResolution.status === 'error' ? (
              <div>
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  Could not resolve skill instructions: {currentSkillResolution.message}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {inspection.enabledSkills.map((id) => (
                    <code key={id} className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
                      {id} · unavailable
                    </code>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {currentSkillResolution.context.unavailableSkillIds.length > 0 && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    <p className="font-medium">Unavailable skills are not added by the runtime:</p>
                    <p className="mt-1 break-all font-mono">
                      {currentSkillResolution.context.unavailableSkillIds.join(', ')}
                    </p>
                  </div>
                )}
                {currentSkillResolution.context.failedSkills.map((failure) => (
                  <p key={failure.id} role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
                    <code>{failure.id}</code> could not be inspected: {failure.message}
                  </p>
                ))}
                {skillExpansion.skills.map(({ skill, includedContent, truncated }) => (
                  <details key={skill.id} className="rounded-lg bg-surface-50 px-3 py-2 dark:bg-surface-900">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{skill.name}</p>
                          <p className="mt-0.5 break-all text-xs text-surface-500">
                            {skill.source} · {skill.sourcePath} · {formatBytes(skill.size)}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-surface-500">
                          {truncated ? 'Runtime-truncated' : 'Included in full'}
                        </span>
                      </div>
                    </summary>
                    {skill.description && (
                      <p className="mt-3 text-xs leading-5 text-surface-500">{skill.description}</p>
                    )}
                    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-950 p-3 text-xs leading-5 text-surface-100">
                      {includedContent}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </Section>

          <Section title="Tools, skills, and permission policy">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-surface-500">Policy</span>
              <span className="rounded-full bg-surface-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide dark:bg-surface-900">
                {inspection.policy}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-surface-500">
              {POLICY_DESCRIPTIONS[inspection.policy] ?? 'The task uses a custom permission policy.'}
            </p>
            <p className="mt-3 text-xs font-medium text-surface-500">Enabled tools</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {inspection.enabledTools.length ? inspection.enabledTools.map((tool) => (
                <code key={tool} className="rounded-md bg-surface-100 px-2 py-1 text-xs dark:bg-surface-900">{tool}</code>
              )) : <p className="text-sm text-surface-500">No tools are enabled.</p>}
            </div>
            <p className="mt-4 text-xs font-medium text-surface-500">Configured skill IDs</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {inspection.enabledSkills.length ? inspection.enabledSkills.map((skill) => (
                <code key={skill} className="rounded-md bg-surface-100 px-2 py-1 text-xs dark:bg-surface-900">{skill}</code>
              )) : <p className="text-sm text-surface-500">No skills are enabled.</p>}
            </div>
          </Section>

          <Section title="Token budget and compaction">
            <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-surface-500">Frontend estimate</dt>
              <dd>
                {tokenUsage.used === null ? 'Not measured yet' : tokenUsage.used.toLocaleString()}
                {tokenUsage.budget !== null ? ` / ${tokenUsage.budget.toLocaleString()}` : ''}
                {tokenPercent !== null ? ` (${tokenPercent}%)` : ''}
              </dd>
              <dt className="text-surface-500">Frontend remaining</dt>
              <dd>{tokenUsage.remaining === null ? 'Not measured yet' : tokenUsage.remaining.toLocaleString()}</dd>
              {inspection.requestStage === 'desktop-task' && inspection.enabledSkills.length > 0 && (
                <>
                  <dt className="text-surface-500">Runtime skills</dt>
                  <dd>
                    {runtimeSkillTokens === null
                      ? 'Unavailable until every selected skill resolves'
                      : `+${runtimeSkillTokens.toLocaleString()} estimated tokens after compaction`}
                  </dd>
                  <dt className="text-surface-500">Effective estimate</dt>
                  <dd className={effectiveTokenPercent !== null && effectiveTokenPercent > 100 ? 'text-red-600 dark:text-red-400' : ''}>
                    {effectiveTokenEstimate === null
                      ? 'Unavailable'
                      : `${effectiveTokenEstimate.toLocaleString()}${tokenUsage.budget !== null ? ` / ${tokenUsage.budget.toLocaleString()}` : ''}${effectiveTokenPercent !== null ? ` (${effectiveTokenPercent}%)` : ''}`}
                  </dd>
                </>
              )}
              <dt className="text-surface-500">Frontend compaction</dt>
              <dd>
                {tokenUsage.compactionCount
                  ? `${tokenUsage.compactionCount} run${tokenUsage.compactionCount === 1 ? '' : 's'}; ${tokenUsage.compactedMessages} message${tokenUsage.compactedMessages === 1 ? '' : 's'} removed in the latest pass`
                  : 'Not compacted'}
              </dd>
              {tokenUsage.measuredAt && (
                <>
                  <dt className="text-surface-500">Calculated</dt>
                  <dd>{new Date(tokenUsage.measuredAt).toLocaleString()}</dd>
                </>
              )}
              {tokenUsage.lastCompactedAt && (
                <>
                  <dt className="text-surface-500">Last compacted</dt>
                  <dd>{new Date(tokenUsage.lastCompactedAt).toLocaleString()}</dd>
                </>
              )}
            </dl>
            {tokenUsage.summary && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">Compacted summary</summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-50 p-3 text-xs leading-5 dark:bg-surface-900">
                  {tokenUsage.summary}
                </pre>
              </details>
            )}
          </Section>

          <Section title={inspection.requestStage === 'desktop-task' ? 'Pre-runtime desktop request' : 'Exactly what is sent'}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs leading-5 text-surface-500">
                {inspection.requestStage === 'desktop-task'
                  ? 'Exact JSON sent to /desktop/tasks before the runtime resolves skills and assembles the effective prompt above.'
                  : 'Exact JSON provider request body before transport.'}
              </p>
              <button type="button" onClick={() => void copyRequest()} className="btn-ghost !px-2 !py-1.5 text-xs">
                {copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-950 p-3 text-xs leading-5 text-surface-100">
              {serializedRequest}
            </pre>
          </Section>
        </div>
      </aside>
    </div>
  );
}
