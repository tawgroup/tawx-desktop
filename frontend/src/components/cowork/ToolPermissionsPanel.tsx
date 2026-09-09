import type { ToolCapability } from '../../store/useToolCapabilities';

export type TaskPolicy = 'plan' | 'ask' | 'allow';

interface ToolPermissionsPanelProps {
  scopeLabel: string;
  workspacePath?: string;
  policy: TaskPolicy;
  enabledTools: string[];
  tools: ToolCapability[];
  runtimeStatus: 'idle' | 'loading' | 'connected' | 'unavailable';
  runtimeError?: string | null;
  onPolicyChange: (policy: TaskPolicy) => void;
  onToggleTool: (name: string) => void;
  onRefreshCapabilities: () => void;
  onSelectWorkspace: () => void;
}

const POLICY_OPTIONS: Array<{ value: TaskPolicy; label: string; description: string }> = [
  { value: 'plan', label: 'Plan', description: 'Inspect and plan. File mutations and commands are denied.' },
  { value: 'ask', label: 'Ask', description: 'Read directly. Ask before writes, commands, Git actions, browser actions, and MCP.' },
  { value: 'allow', label: 'Allow', description: 'Use enabled safe tools without prompting. Destructive Git and workspace escape stay denied.' },
];

const STATUS_LABEL: Record<ToolPermissionsPanelProps['runtimeStatus'], string> = {
  idle: 'Checking runtime',
  loading: 'Checking runtime',
  connected: 'Runtime connected',
  unavailable: 'Runtime unavailable',
};

export default function ToolPermissionsPanel({
  scopeLabel,
  workspacePath,
  policy,
  enabledTools,
  tools,
  runtimeStatus,
  runtimeError,
  onPolicyChange,
  onToggleTool,
  onRefreshCapabilities,
  onSelectWorkspace,
}: ToolPermissionsPanelProps) {
  const selectedPolicy = POLICY_OPTIONS.find((option) => option.value === policy);
  const registeredToolNames = new Set(tools.map((tool) => tool.name));
  const configuredUnavailableTools = enabledTools.filter((name) => !registeredToolNames.has(name));

  return (
    <>
      <section className="rounded-2xl border border-surface-200 p-4 dark:border-surface-800" aria-labelledby="project-permissions-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="project-permissions-title" className="font-semibold">Project and thread policy</h2>
            <p className="mt-1 text-sm text-surface-500">These settings belong to {scopeLabel} and are used by its next task.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {workspacePath ? <code className="break-all text-xs text-surface-500">{workspacePath}</code> : <p className="text-xs text-amber-600 dark:text-amber-400">Select a project folder before running workspace tools.</p>}
              <button type="button" onClick={onSelectWorkspace} className="shrink-0 text-xs font-medium text-accent hover:underline">
                {workspacePath ? 'Change project' : 'Choose project'}
              </button>
            </div>
          </div>
          <div className="text-right">
            <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${runtimeStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : runtimeStatus === 'unavailable' ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-surface-100 text-surface-500 dark:bg-surface-800'}`}>{STATUS_LABEL[runtimeStatus]}</span>
            {runtimeStatus === 'unavailable' && <button type="button" onClick={onRefreshCapabilities} className="mt-2 block w-full text-xs font-medium text-accent hover:underline">Retry</button>}
          </div>
        </div>
        {runtimeError && <p role="status" className="mt-3 text-xs text-red-600 dark:text-red-400">{runtimeError}</p>}

        <fieldset className="mt-5 grid gap-2 sm:grid-cols-3">
          <legend className="sr-only">Task permission policy</legend>
          {POLICY_OPTIONS.map((option) => (
            <label key={option.value} className={`cursor-pointer rounded-xl border p-3 transition-colors ${policy === option.value ? 'border-accent bg-accent/5' : 'border-surface-200 hover:border-surface-300 dark:border-surface-800 dark:hover:border-surface-700'}`}>
              <span className="flex items-center gap-2">
                <input type="radio" name="task-policy" value={option.value} checked={policy === option.value} onChange={() => onPolicyChange(option.value)} />
                <span className="font-medium">{option.label}</span>
              </span>
              <span className="mt-2 block text-xs leading-5 text-surface-500">{option.description}</span>
            </label>
          ))}
        </fieldset>
        {selectedPolicy && <p className="mt-3 text-xs text-surface-500"><span className="font-medium text-surface-700 dark:text-surface-300">Effective policy:</span> {selectedPolicy.description}</p>}
      </section>

      <section className="overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-800" aria-labelledby="enabled-tools-title">
        <div className="border-b border-surface-200 p-4 dark:border-surface-800">
          <h2 id="enabled-tools-title" className="font-semibold">Enabled tools</h2>
          <p className="mt-1 text-sm text-surface-500">Only enabled capabilities are included in the next task request. Policy rules still apply.</p>
        </div>
        {runtimeStatus === 'idle' || runtimeStatus === 'loading' ? (
          <p className="p-4 text-sm text-surface-500">Loading tool capabilities from the desktop runtime…</p>
        ) : runtimeStatus === 'unavailable' ? (
          <p className="p-4 text-sm text-surface-500">The runtime capability list is unavailable. Existing selections remain saved and can be disabled below.</p>
        ) : tools.length === 0 ? (
          <p className="p-4 text-sm text-surface-500">The desktop runtime reported no tool capabilities.</p>
        ) : null}
        {tools.map((tool) => {
          const enabled = enabledTools.includes(tool.name);
          return (
            <div key={tool.name} className="flex items-center gap-4 border-b border-surface-200 p-4 last:border-b-0 dark:border-surface-800">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold capitalize">{tool.name.replaceAll('_', ' ')}</h3>
                  <code className="rounded bg-surface-100 px-1.5 py-0.5 text-[10px] text-surface-500 dark:bg-surface-800">{tool.name}</code>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">Available</span>
                  <span className="rounded-full bg-surface-100 px-2 py-0.5 text-[10px] capitalize text-surface-500 dark:bg-surface-800">{tool.category}</span>
                </div>
                <p className="mt-1 text-sm leading-6 text-surface-500">{tool.description}</p>
              </div>
              <ToolSwitch name={tool.name} enabled={enabled} onToggle={onToggleTool} />
            </div>
          );
        })}
        {configuredUnavailableTools.map((name) => (
          <div key={name} className="flex items-center gap-4 border-b border-surface-200 p-4 last:border-b-0 dark:border-surface-800">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold capitalize">{name.replaceAll('_', ' ')}</h3>
                <code className="rounded bg-surface-100 px-1.5 py-0.5 text-[10px] text-surface-500 dark:bg-surface-800">{name}</code>
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">Not reported by runtime</span>
              </div>
              <p className="mt-1 text-sm leading-6 text-surface-500">This saved tool selection is not present in the current capability response.</p>
            </div>
            <ToolSwitch name={name} enabled onToggle={onToggleTool} />
          </div>
        ))}
      </section>
    </>
  );
}

function ToolSwitch({ name, enabled, onToggle }: { name: string; enabled: boolean; onToggle: (name: string) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={`Enable ${name}`}
      aria-checked={enabled}
      onClick={() => onToggle(name)}
      className={`h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${enabled ? 'bg-accent' : 'bg-surface-200 dark:bg-surface-700'}`}
    >
      <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : ''}`} />
    </button>
  );
}
