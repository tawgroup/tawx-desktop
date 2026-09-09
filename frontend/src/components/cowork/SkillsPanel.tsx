import { useEffect, useRef, useState } from 'react';

export type SkillConfigurationScope = 'project' | 'thread';
export type SkillSource = 'project' | 'user';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourcePath: string;
  size: number;
  updatedAt: number;
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface SkillCatalog {
  skills: SkillSummary[];
  enabledSkillIds: string[];
  unavailableSkillIds: string[];
  scope: SkillConfigurationScope;
  inherited: boolean;
  workspace?: string;
}

export interface SkillsPanelSelection {
  enabledSkillIds: string[];
  enabledSkills: SkillSummary[];
  scope: SkillConfigurationScope;
  inherited: boolean;
}

export interface SkillsPanelProps {
  workspacePath?: string | null;
  threadId?: string | null;
  onEnabledSkillsChange?: (selection: SkillsPanelSelection) => void;
}

export default function SkillsPanel({ workspacePath, threadId, onEnabledSkillsChange }: SkillsPanelProps) {
  const [scope, setScope] = useState<SkillConfigurationScope>(() => threadId ? 'thread' : 'project');
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [preview, setPreview] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectionListener = useRef(onEnabledSkillsChange);
  selectionListener.current = onEnabledSkillsChange;
  const effectiveScope = threadId ? scope : 'project';
  const viewKey = JSON.stringify([workspacePath ?? null, threadId ?? null, effectiveScope]);
  const activeView = useRef(viewKey);
  activeView.current = viewKey;

  useEffect(() => {
    if (!threadId) setScope('project');
  }, [threadId]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setLoading(true);
    setError(null);
    setPreview(null);

    void requestCatalog(workspacePath, threadId, effectiveScope, controller.signal)
      .then(async (nextCatalog) => {
        setCatalog(nextCatalog);
        const contextCatalog = threadId && effectiveScope === 'project'
          ? await requestCatalog(workspacePath, threadId, 'thread', controller.signal)
          : nextCatalog;
        selectionListener.current?.(selectionState(contextCatalog));
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError(reason instanceof Error ? reason.message : 'Could not load local skills.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [workspacePath, threadId, effectiveScope]);

  const toggleSkill = async (skillId: string) => {
    if (!catalog || saving) return;
    const enabledSkillIds = catalog.enabledSkillIds.includes(skillId)
      ? catalog.enabledSkillIds.filter((id) => id !== skillId)
      : [...catalog.enabledSkillIds, skillId];
    await saveSelection(enabledSkillIds, false, skillId);
  };

  const saveSelection = async (enabledSkillIds: string[], inheritProject: boolean, savingKey: string) => {
    const requestedView = viewKey;
    setSaving(savingKey);
    setError(null);
    try {
      const response = await fetch('/desktop/skills/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(workspacePath ? { workspace: workspacePath } : {}),
          ...(effectiveScope === 'thread' && threadId ? { threadId } : {}),
          scope: effectiveScope,
          enabledSkillIds,
          ...(inheritProject ? { inheritProject: true } : {}),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const nextCatalog = await response.json() as SkillCatalog;
      if (activeView.current !== requestedView) return;
      setCatalog(nextCatalog);
      const contextCatalog = threadId && effectiveScope === 'project'
        ? await requestCatalog(workspacePath, threadId, 'thread')
        : nextCatalog;
      if (activeView.current !== requestedView) return;
      selectionListener.current?.(selectionState(contextCatalog));
    } catch (reason) {
      if (activeView.current === requestedView) {
        setError(reason instanceof Error ? reason.message : 'Could not save the skill selection.');
      }
    } finally {
      setSaving(null);
    }
  };

  const inspectSkill = async (skill: SkillSummary) => {
    const requestedView = viewKey;
    setSaving(`preview:${skill.id}`);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (workspacePath) query.set('workspace', workspacePath);
      const response = await fetch(`/desktop/skills/${encodeURIComponent(skill.id)}?${query}`);
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { skill: SkillDetail };
      if (activeView.current !== requestedView) return;
      setPreview(result.skill);
    } catch (reason) {
      if (activeView.current === requestedView) {
        setError(reason instanceof Error ? reason.message : 'Could not open the skill.');
      }
    } finally {
      setSaving(null);
    }
  };

  const enabledCount = catalog?.enabledSkillIds.length ?? 0;

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-accent">TAWX Desktop</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Skills</h1>
            <p className="mt-2 max-w-2xl text-sm text-surface-500">
              Local instruction sets discovered from the selected repository and your user skill folders.
            </p>
          </div>
          <div className="rounded-full border border-surface-200 px-3 py-1 text-xs text-surface-500 dark:border-surface-800">
            {loading ? 'Discovering skills' : `${catalog?.skills.length ?? 0} discovered`}
          </div>
        </div>

        <section className="mb-4 rounded-2xl border border-surface-200 p-4 dark:border-surface-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Instruction context</h2>
              <p className="mt-1 text-sm text-surface-500">
                {enabledCount === 0
                  ? 'No skills are included in Cowork context.'
                  : `${enabledCount} ${enabledCount === 1 ? 'skill is' : 'skills are'} included in Cowork context.`}
              </p>
            </div>
            <div className="flex rounded-xl bg-surface-100 p-1 dark:bg-surface-800" aria-label="Skill selection scope">
              <button
                type="button"
                aria-pressed={effectiveScope === 'project'}
                disabled={saving !== null}
                onClick={() => setScope('project')}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${effectiveScope === 'project' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-white' : 'text-surface-500'}`}
              >
                {workspacePath ? 'Project default' : 'Global default'}
              </button>
              <button
                type="button"
                aria-pressed={effectiveScope === 'thread'}
                disabled={!threadId || saving !== null}
                onClick={() => setScope('thread')}
                title={threadId ? 'Configure this conversation' : 'Start a conversation to create a thread override'}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${effectiveScope === 'thread' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-white' : 'text-surface-500'}`}
              >
                This thread
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-surface-500">
            Skills provide procedural guidance only. They do not grant tool access, bypass approvals, or execute embedded commands.
          </p>
          {effectiveScope === 'thread' && catalog?.inherited && (
            <p className="mt-2 text-xs text-accent">This thread currently inherits the project default.</p>
          )}
          {effectiveScope === 'thread' && catalog && !catalog.inherited && (
            <button
              type="button"
              disabled={saving !== null}
              onClick={() => void saveSelection([], true, 'inherit')}
              className="mt-3 text-xs font-medium text-accent hover:underline disabled:opacity-50"
            >
              Use project default
            </button>
          )}
        </section>

        {error && (
          <div role="alert" className="mb-4 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-sm text-red-500">
            {error}
          </div>
        )}

        {catalog && catalog.unavailableSkillIds.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
            {catalog.unavailableSkillIds.length} enabled {catalog.unavailableSkillIds.length === 1 ? 'skill is' : 'skills are'} unavailable and will not be added to context.
          </div>
        )}

        {loading && !catalog ? (
          <div className="rounded-2xl border border-surface-200 p-8 text-center text-sm text-surface-500 dark:border-surface-800">
            Reading local skill metadata…
          </div>
        ) : catalog?.skills.length === 0 ? (
          <div className="rounded-2xl border border-surface-200 p-8 text-center dark:border-surface-800">
            <h2 className="font-semibold">No local skills found</h2>
            <p className="mt-2 text-sm text-surface-500">
              Add a SKILL.md under .claude/skills or .agents/skills in the selected project, or in a supported user skill folder.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {catalog?.skills.map((skill) => {
              const enabled = catalog.enabledSkillIds.includes(skill.id);
              return (
                <article key={skill.id} className="rounded-2xl border border-surface-200 p-4 dark:border-surface-800">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-100 text-sm font-semibold text-accent dark:bg-surface-800">
                      S
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold">{skill.name}</h2>
                        <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-surface-500 dark:bg-surface-800">
                          {skill.source}
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-6 text-surface-500">{skill.description}</p>
                      <p className="mt-2 truncate text-xs text-surface-400" title={skill.sourcePath}>{skill.sourcePath}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                      aria-checked={enabled}
                      disabled={saving !== null}
                      onClick={() => void toggleSkill(skill.id)}
                      className={`h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-50 ${enabled ? 'bg-accent' : 'bg-surface-200 dark:bg-surface-700'}`}
                    >
                      <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-surface-100 pt-3 dark:border-surface-800">
                    <span className="text-xs text-surface-400">{formatBytes(skill.size)}</span>
                    <button
                      type="button"
                      disabled={saving !== null}
                      onClick={() => void inspectSkill(skill)}
                      className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
                    >
                      {saving === `preview:${skill.id}` ? 'Opening…' : 'Inspect instructions'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {preview && (
          <section className="mt-5 overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-800" aria-label={`${preview.name} instructions`}>
            <div className="flex items-start justify-between gap-4 border-b border-surface-200 p-4 dark:border-surface-800">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-accent">Instruction preview</p>
                <h2 className="mt-1 font-semibold">{preview.name}</h2>
                <p className="mt-1 break-all text-xs text-surface-400">{preview.sourcePath}</p>
              </div>
              <button type="button" className="btn-ghost" onClick={() => setPreview(null)} aria-label="Close skill preview">Close</button>
            </div>
            <pre className="scrollbar-thin max-h-[32rem] overflow-auto whitespace-pre-wrap break-words bg-surface-50 p-4 text-xs leading-6 text-surface-700 dark:bg-surface-950 dark:text-surface-300">
              {preview.content || 'This skill has no instruction body.'}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}

async function requestCatalog(
  workspacePath: string | null | undefined,
  threadId: string | null | undefined,
  scope: SkillConfigurationScope,
  signal?: AbortSignal,
): Promise<SkillCatalog> {
  const response = await fetch(`/desktop/skills?${selectionQuery(workspacePath, threadId, scope)}`, { signal });
  if (!response.ok) throw new Error(await responseError(response));
  return await response.json() as SkillCatalog;
}

function selectionQuery(
  workspacePath: string | null | undefined,
  threadId: string | null | undefined,
  scope: SkillConfigurationScope,
): URLSearchParams {
  const query = new URLSearchParams({ scope });
  if (workspacePath) query.set('workspace', workspacePath);
  if (scope === 'thread' && threadId) query.set('threadId', threadId);
  return query;
}

function selectionState(catalog: SkillCatalog): SkillsPanelSelection {
  const selectedIds = new Set(catalog.enabledSkillIds);
  return {
    enabledSkillIds: [...catalog.enabledSkillIds],
    enabledSkills: catalog.skills.filter((skill) => selectedIds.has(skill.id)),
    scope: catalog.scope,
    inherited: catalog.inherited,
  };
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `Request failed with status ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return parsed.error?.message || parsed.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}
