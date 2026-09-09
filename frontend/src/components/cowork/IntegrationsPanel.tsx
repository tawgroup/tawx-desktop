import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { desktopWorkspaceUrl, workspacePost } from './integrationUrls';

interface CapabilityStatus {
  id: string;
  name: string;
  available: boolean;
  configured: boolean;
  detail: string;
  toolCount: number;
}

interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport:
    | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { type: 'http'; url: string; headers?: Record<string, string> };
}

interface McpServerStatus {
  config: McpServerConfig;
  state: 'disabled' | 'disconnected' | 'connected' | 'error';
  detail: string;
  tools: string[];
}

interface IntegrationSnapshot {
  capabilities: CapabilityStatus[];
  mcpServers: McpServerStatus[];
}

interface ArtifactMetadata {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  modifiedAt: string;
}

interface ArtifactPreview extends ArtifactMetadata {
  preview:
    | { kind: 'text'; content: string; truncated: boolean }
    | { kind: 'image'; content: string; truncated: false }
    | { kind: 'binary'; content: null; truncated: false };
}

interface ServerDraft {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  target: string;
  args: string;
  references: string;
  enabled: boolean;
}

const EMPTY_SERVER: ServerDraft = {
  id: '',
  name: '',
  transport: 'stdio',
  target: '',
  args: '',
  references: '',
  enabled: true,
};
interface IntegrationsPanelProps {
  workspacePath?: string;
}


export default function IntegrationsPanel({ workspacePath }: IntegrationsPanelProps) {
  const [snapshot, setSnapshot] = useState<IntegrationSnapshot | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactMetadata[]>([]);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifactMessage, setArtifactMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(EMPTY_SERVER);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [integrationsResult, artifactsResult] = await Promise.allSettled([
      desktopJson<IntegrationSnapshot>(desktopWorkspaceUrl('/desktop/integrations', workspacePath)),
      desktopJson<ArtifactMetadata[]>(desktopWorkspaceUrl('/desktop/artifacts', workspacePath)),
    ]);
    if (integrationsResult.status === 'fulfilled') setSnapshot(integrationsResult.value);
    else setError(messageOf(integrationsResult.reason));
    if (artifactsResult.status === 'fulfilled') {
      setArtifacts(artifactsResult.value);
      setArtifactMessage(null);
    } else {
      setArtifacts([]);
      setArtifactMessage(messageOf(artifactsResult.reason));
    }
    setLoading(false);
  }, [workspacePath]);

  useEffect(() => {
    setPreview(null);
    void refresh();
  }, [refresh]);
  const openEditor = (config?: McpServerConfig) => {
    setEditingId(config?.id ?? null);
    setDraft(config ? serverToDraft(config) : EMPTY_SERVER);
    setAdding(true);
  };


  const saveServer = async (event: FormEvent) => {
    event.preventDefault();
    setWorking('save');
    setError(null);
    try {
      const config = draftToConfig(draft);
      await desktopJson(`/desktop/integrations/mcp/${encodeURIComponent(config.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      setAdding(false);
      setEditingId(null);
      setDraft(EMPTY_SERVER);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setWorking(null);
    }
  };

  const updateServer = async (config: McpServerConfig) => {
    setWorking(config.id);
    setError(null);
    try {
      await desktopJson(`/desktop/integrations/mcp/${encodeURIComponent(config.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setWorking(null);
    }
  };

  const connectServer = async (id: string) => {
    setWorking(id);
    setError(null);
    try {
      await desktopJson(`/desktop/integrations/mcp/${encodeURIComponent(id)}/connect`, workspacePost(workspacePath));
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
      await refresh();
    } finally {
      setWorking(null);
    }
  };

  const removeServer = async (id: string) => {
    setWorking(id);
    setError(null);
    try {
      await desktopJson(`/desktop/integrations/mcp/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setWorking(null);
    }
  };

  const openArtifact = async (artifact: ArtifactMetadata) => {
    setWorking(`artifact:${artifact.id}`);
    setArtifactMessage(null);
    try {
      setPreview(await desktopJson<ArtifactPreview>(desktopWorkspaceUrl(`/desktop/artifacts/${encodeURIComponent(artifact.id)}`, workspacePath)));
    } catch (cause) {
      setArtifactMessage(messageOf(cause));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-8">
        <header>
          <h2 className="text-lg font-semibold">Integrations</h2>
          <p className="mt-1 text-sm text-surface-700/60 dark:text-surface-200/50">
            Connect bounded browser and MCP tools. Every external action still goes through task approval and the audit log.
          </p>
        </header>

        {error && <Notice tone="error">{error}</Notice>}
        {loading && !snapshot && <p className="text-sm text-surface-700/60 dark:text-surface-200/50">Loading runtime status…</p>}

        {snapshot && (
          <section aria-labelledby="capabilities-heading">
            <h3 id="capabilities-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">
              Runtime capabilities
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {snapshot.capabilities.map((capability) => (
                <article key={capability.id} className="rounded-xl border border-surface-200 bg-white p-4 dark:border-surface-700 dark:bg-surface-800">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-semibold">{capability.name}</h4>
                    <StatusBadge active={capability.available} label={capability.available ? 'Available' : capability.configured ? 'Unavailable' : 'Not configured'} />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-surface-700/65 dark:text-surface-200/55">{capability.detail}</p>
                  <p className="mt-3 text-xs font-medium">{capability.toolCount} agent tool{capability.toolCount === 1 ? '' : 's'}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        <section aria-labelledby="mcp-heading">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h3 id="mcp-heading" className="text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">MCP servers</h3>
              <p className="mt-1 text-xs text-surface-700/60 dark:text-surface-200/45">
                Credential values are never saved here; reference them by environment variable name. Enable MCP in task permissions to expose discovered tools.
              </p>
            </div>
            <button type="button" className="btn-ghost shrink-0 border border-surface-200 bg-white text-sm dark:border-surface-700 dark:bg-surface-800" onClick={() => {
              if (adding) {
                setAdding(false);
                setEditingId(null);
                setDraft(EMPTY_SERVER);
              } else {
                openEditor();
              }
            }}>
              {adding ? 'Cancel' : 'Add server'}
            </button>
          </div>

          {adding && (
            <form onSubmit={(event) => void saveServer(event)} className="mb-3 space-y-3 rounded-xl border border-surface-200 bg-white p-4 dark:border-surface-700 dark:bg-surface-800">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Server name">
                  <input className="input w-full" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="GitHub" />
                </Field>
                <Field label="Server id">
                  <input className="input w-full" required disabled={editingId !== null} pattern="[a-z0-9][a-z0-9_-]{0,63}" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value.toLowerCase() })} placeholder="github" />
                </Field>
              </div>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="radio" checked={draft.transport === 'stdio'} onChange={() => setDraft({ ...draft, transport: 'stdio', target: '', references: '' })} /> Local stdio</label>
                <label className="flex items-center gap-2"><input type="radio" checked={draft.transport === 'http'} onChange={() => setDraft({ ...draft, transport: 'http', target: '', references: '' })} /> Streamable HTTP</label>
              </div>
              <Field label={draft.transport === 'stdio' ? 'Command' : 'Server URL'}>
                <input className="input w-full font-mono text-xs" required value={draft.target} onChange={(event) => setDraft({ ...draft, target: event.target.value })} placeholder={draft.transport === 'stdio' ? 'npx' : 'https://mcp.example.com/mcp'} />
              </Field>
              {draft.transport === 'stdio' && (
                <Field label="Arguments (one per line)">
                  <textarea className="input min-h-20 w-full font-mono text-xs" value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder={'-y\n@modelcontextprotocol/server-github'} />
                </Field>
              )}
              <Field label={draft.transport === 'stdio' ? 'Environment references (CHILD_KEY=HOST_ENV)' : 'Header references (Header=HOST_ENV)'}>
                <textarea className="input min-h-16 w-full font-mono text-xs" value={draft.references} onChange={(event) => setDraft({ ...draft, references: event.target.value })} placeholder={draft.transport === 'stdio' ? 'GITHUB_TOKEN=GITHUB_TOKEN' : 'Authorization=MCP_AUTH_HEADER'} />
              </Field>
              <div className="flex justify-end">
                <button type="submit" className="btn-primary text-sm" disabled={working === 'save'}>{working === 'save' ? 'Saving…' : editingId ? 'Update server' : 'Save server'}</button>
              </div>
            </form>
          )}

          <div className="space-y-2">
            {snapshot?.mcpServers.length === 0 && !adding && (
              <div className="rounded-xl border border-dashed border-surface-300 px-4 py-6 text-center text-sm text-surface-700/60 dark:border-surface-600 dark:text-surface-200/50">
                No MCP servers configured. Add one to discover real agent tools.
              </div>
            )}
            {snapshot?.mcpServers.map(({ config, state, detail, tools }) => (
              <article key={config.id} className="rounded-xl border border-surface-200 bg-white p-4 dark:border-surface-700 dark:bg-surface-800">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-sm font-semibold">{config.name}</h4>
                      <StatusBadge active={state === 'connected'} label={state.replace('_', ' ')} />
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-surface-700/55 dark:text-surface-200/45">{transportLabel(config)}</p>
                    <p className={`mt-2 text-xs ${state === 'error' ? 'text-red-600 dark:text-red-400' : 'text-surface-700/65 dark:text-surface-200/55'}`}>{detail}</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={config.enabled} disabled={working === config.id} onChange={() => void updateServer({ ...config, enabled: !config.enabled })} /> Enabled
                  </label>
                  {config.enabled && state !== 'connected' && <button type="button" className="btn-ghost border border-surface-200 bg-white text-xs dark:border-surface-700 dark:bg-surface-900" disabled={working === config.id} onClick={() => void connectServer(config.id)}>Connect</button>}
                  <button type="button" className="btn-ghost text-xs" disabled={working === config.id} onClick={() => openEditor(config)}>Edit</button>
                  <button type="button" className="btn-ghost text-xs text-red-600 dark:text-red-400" disabled={working === config.id} onClick={() => void removeServer(config.id)}>Remove</button>
                </div>
                {tools.length > 0 && <p className="mt-3 text-xs text-surface-700/60 dark:text-surface-200/50">Tools: {tools.join(', ')}</p>}
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="artifacts-heading">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h3 id="artifacts-heading" className="text-sm font-semibold uppercase tracking-wide text-surface-700/60 dark:text-surface-200/50">Project artifacts</h3>
              <p className="mt-1 text-xs text-surface-700/60 dark:text-surface-200/45">Safe deliverables stored under .tawx/artifacts in the selected project.</p>
            </div>
            <button type="button" className="btn-ghost text-xs" onClick={() => void refresh()}>Refresh</button>
          </div>
          {artifactMessage && <Notice tone="neutral">{artifactMessage}</Notice>}
          {!artifactMessage && artifacts.length === 0 && <p className="rounded-xl border border-dashed border-surface-300 px-4 py-6 text-center text-sm text-surface-700/60 dark:border-surface-600 dark:text-surface-200/50">No artifacts in this project yet.</p>}
          <div className="space-y-2">
            {artifacts.map((artifact) => (
              <button key={artifact.id} type="button" onClick={() => void openArtifact(artifact)} className="flex w-full items-center gap-3 rounded-xl border border-surface-200 bg-white p-3 text-left hover:border-surface-400 dark:border-surface-700 dark:bg-surface-800 dark:hover:border-surface-500">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{artifact.name}</p>
                  <p className="truncate text-xs text-surface-700/55 dark:text-surface-200/45">{artifact.path} · {formatBytes(artifact.size)} · {artifact.mimeType}</p>
                </div>
                <span className="text-xs text-surface-700/50 dark:text-surface-200/40">{working === `artifact:${artifact.id}` ? 'Loading…' : 'Preview'}</span>
              </button>
            ))}
          </div>
          {preview && <ArtifactPreviewCard artifact={preview} onClose={() => setPreview(null)} />}
        </section>
      </div>
    </div>
  );
}

function ArtifactPreviewCard({ artifact, onClose }: { artifact: ArtifactPreview; onClose: () => void }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-700 dark:bg-surface-800">
      <div className="flex items-center justify-between border-b border-surface-200 px-4 py-3 dark:border-surface-700">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{artifact.name}</p>
          <p className="text-xs text-surface-700/50 dark:text-surface-200/40">{artifact.mimeType} · {formatBytes(artifact.size)}</p>
        </div>
        <button type="button" className="btn-ghost text-xs" onClick={onClose}>Close</button>
      </div>
      {artifact.preview.kind === 'text' && (
        <div>
          <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5">{artifact.preview.content}</pre>
          {artifact.preview.truncated && <p className="border-t border-surface-200 px-4 py-2 text-xs text-amber-700 dark:border-surface-700 dark:text-amber-300">Preview truncated to the safe display limit.</p>}
        </div>
      )}
      {artifact.preview.kind === 'image' && <img src={artifact.preview.content} alt={`Preview of ${artifact.name}`} className="max-h-96 w-full object-contain p-4" />}
      {artifact.preview.kind === 'binary' && <p className="p-4 text-sm text-surface-700/60 dark:text-surface-200/50">This binary format has no safe inline preview.</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-medium"><span className="mb-1 block">{label}</span>{children}</label>;
}

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-surface-100 text-surface-600 dark:bg-surface-700 dark:text-surface-300'}`}>{label}</span>;
}

function Notice({ tone, children }: { tone: 'error' | 'neutral'; children: ReactNode }) {
  return <p className={`mb-3 rounded-lg px-3 py-2 text-xs ${tone === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300' : 'bg-surface-100 text-surface-700 dark:bg-surface-800 dark:text-surface-200'}`}>{children}</p>;
}

function serverToDraft(config: McpServerConfig): ServerDraft {
  if (config.transport.type === 'stdio') {
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      transport: 'stdio',
      target: config.transport.command,
      args: (config.transport.args ?? []).join('\n'),
      references: Object.entries(config.transport.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    };
  }
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport: 'http',
    target: config.transport.url,
    args: '',
    references: Object.entries(config.transport.headers ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
  };
}

function draftToConfig(draft: ServerDraft): McpServerConfig {
  const references = parseReferences(draft.references);
  if (draft.transport === 'stdio') {
    return {
      id: draft.id.trim(),
      name: draft.name.trim(),
      enabled: draft.enabled,
      transport: {
        type: 'stdio',
        command: draft.target.trim(),
        args: draft.args.split('\n').map((line) => line.trim()).filter(Boolean),
        env: references,
      },
    };
  }
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: { type: 'http', url: draft.target.trim(), headers: references },
  };
}

function parseReferences(value: string): Record<string, string> | undefined {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const references: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator < 1 || separator === line.length - 1) throw new Error(`Invalid environment reference '${line}'`);
    references[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return references;
}

function transportLabel(config: McpServerConfig): string {
  return config.transport.type === 'stdio'
    ? [config.transport.command, ...(config.transport.args ?? [])].join(' ')
    : config.transport.url;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function desktopJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }
  if (!response.ok) {
    let detail = body;
    if (body && typeof body === 'object' && 'error' in body) detail = body.error;
    const message = detail && typeof detail === 'object' && 'message' in detail
      ? String(detail.message)
      : typeof detail === 'string' ? detail : `Desktop runtime returned ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
