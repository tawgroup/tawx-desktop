import { useEffect, useState } from 'react';
import type { CoworkSection } from '../types';

const builtInTools = [
  ['read', 'Read files', 'Inspect files inside the selected project', 'Read only'],
  ['write', 'Write files', 'Create and edit files inside the selected project', 'Ask each time'],
  ['bash', 'Run bash', 'Execute commands with the selected project as working directory', 'Ask each time'],
] as const;

const extraTools = [
  ['Browser', 'Navigate, inspect, and interact with websites', 'Runtime needed'],
  ['Web search', 'Research current information with sources', 'Available'],
  ['Apps & MCP', 'Connect mail, calendar, Slack, GitHub, and more', 'Runtime needed'],
  ['Artifacts', 'Preview documents, code, tables, and reports', 'UI ready'],
] as const;

const skills = [
  ['Researcher', 'Search, compare sources, and prepare a cited brief'],
  ['Document creator', 'Turn notes into reports, memos, and polished drafts'],
  ['Spreadsheet analyst', 'Inspect tables, calculate metrics, and explain results'],
  ['Developer', 'Understand a repository, edit code, and run checks'],
] as const;

export default function CoworkHub({ section }: { section: Exclude<CoworkSection, 'tasks'> }) {
  const [enabled, setEnabled] = useState<string[]>([]);
  const [toolAccess, setToolAccess] = useState<Record<string, boolean>>(() => {
    const saved = localStorage.getItem('tawx-tool-access');
    return saved ? JSON.parse(saved) as Record<string, boolean> : { read: true, write: false, bash: false };
  });
  const toggle = (name: string) => setEnabled((items) => items.includes(name) ? items.filter((item) => item !== name) : [...items, name]);

  useEffect(() => localStorage.setItem('tawx-tool-access', JSON.stringify(toolAccess)), [toolAccess]);

  if (section === 'schedules') {
    return (
      <Panel title="Schedules" description="Run approved tasks automatically. This is a frontend preview until the scheduler is connected.">
        {[
          ['Morning brief', 'Every weekday at 08:00', 'Research news and prepare a concise daily brief.'],
          ['Weekly review', 'Friday at 16:00', 'Summarize completed work, open items, and next-week priorities.'],
        ].map(([name, timing, prompt]) => (
          <article key={name} className="flex gap-4 rounded-2xl border border-surface-200 p-4 dark:border-surface-800">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2"><h2 className="font-semibold">{name}</h2><span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-500 dark:bg-surface-800">Mock</span></div>
              <p className="mt-1 text-xs text-accent">{timing}</p>
              <p className="mt-2 text-sm text-surface-500">{prompt}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled.includes(name)}
              onClick={() => toggle(name)}
              className={`mt-1 h-6 w-11 rounded-full p-0.5 transition-colors ${enabled.includes(name) ? 'bg-accent' : 'bg-surface-200 dark:bg-surface-700'}`}
            >
              <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled.includes(name) ? 'translate-x-5' : ''}`} />
            </button>
          </article>
        ))}
      </Panel>
    );
  }

  if (section === 'tools') {
    return (
      <Panel title="Tools" description="Capabilities the agent can use while completing a task.">
        <div className="rounded-2xl border border-surface-200 p-4 dark:border-surface-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold">Project access</h2><p className="mt-1 text-sm text-surface-500">Tools are restricted to the folder selected in the sidebar.</p></div>
            <select aria-label="Project permission profile" defaultValue="ask" className="input !w-auto">
              <option value="plan">Plan only</option>
              <option value="ask">Ask before changes</option>
              <option value="trusted">Trusted project</option>
            </select>
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-800">
          {builtInTools.map(([key, name, description, policy]) => (
            <div key={key} className="flex items-center gap-4 border-b border-surface-200 p-4 last:border-b-0 dark:border-surface-800">
              <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="font-semibold">{name}</h2><span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] text-surface-500 dark:bg-surface-800">{policy}</span></div><p className="mt-1 text-sm text-surface-500">{description}</p></div>
              <button
                type="button"
                role="switch"
                aria-label={`Enable ${name}`}
                aria-checked={toolAccess[key] ?? false}
                onClick={() => setToolAccess((current) => ({ ...current, [key]: !current[key] }))}
                className={`h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${toolAccess[key] ? 'bg-accent' : 'bg-surface-200 dark:bg-surface-700'}`}
              >
                <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${toolAccess[key] ? 'translate-x-5' : ''}`} />
              </button>
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {extraTools.map(([name, description, status]) => (
            <article key={name} className="rounded-2xl border border-surface-200 p-4 dark:border-surface-800">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">{name}</h2>
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${status === 'Available' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-surface-100 text-surface-500 dark:bg-surface-800'}`}>{status}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-surface-500">{description}</p>
            </article>
          ))}
        </div>
        <ApprovalPreview />
      </Panel>
    );
  }

  return (
    <Panel title="Skills" description="Reusable instructions that teach TAWX how to perform a type of work.">
      {skills.map(([name, description]) => (
        <article key={name} className="flex items-center gap-4 rounded-2xl border border-surface-200 p-4 dark:border-surface-800">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-100 text-accent dark:bg-surface-800">✦</div>
          <div className="min-w-0 flex-1"><h2 className="font-semibold">{name}</h2><p className="mt-1 text-sm text-surface-500">{description}</p></div>
          <button type="button" className="btn-ghost border border-surface-200 dark:border-surface-700">Preview</button>
        </article>
      ))}
    </Panel>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-7 flex items-end justify-between gap-4">
          <div><p className="text-xs font-medium text-accent">TAWX Desktop</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 max-w-2xl text-sm text-surface-500">{description}</p></div>
          <span className="shrink-0 rounded-full border border-surface-200 px-3 py-1 text-xs text-surface-500 dark:border-surface-800">Frontend prototype</span>
        </div>
        <div className="space-y-3">{children}</div>
      </div>
    </div>
  );
}

function ApprovalPreview() {
  return (
    <div className="mt-5 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-amber-500">Approval preview</p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-medium">Run command</p><code className="mt-1 block text-xs text-surface-500">npm run build</code></div>
        <div className="flex gap-2"><button type="button" className="btn-ghost border border-surface-200 dark:border-surface-700">Deny</button><button type="button" className="btn-primary">Allow once</button></div>
      </div>
    </div>
  );
}
