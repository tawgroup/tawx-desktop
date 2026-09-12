import { Effect } from 'effect';
import type { DesktopIntegrationRuntime } from '../integrations/index.js';
import { CORE_TOOL_DEFINITIONS, CORE_TOOL_NAMES, createCoreToolRegistration } from '../tools/tools.js';
import type { SerializedToolCheckpoint } from '../tools/tools.js';
import { Workspace } from '../tools/workspace.js';
import type { AgentCapabilityRegistration, ToolCapability } from './types.js';

// Boundary timeouts for the tools/integrations Promise APIs, which live in
// untouched clusters (desktop/src/tools/*, desktop/src/integrations/*).
// Wrapped here — never reimplemented — so a wedged tool fails the call.
const WORKSPACE_SELECT_TIMEOUT_MS = 15_000;
const INTEGRATION_TIMEOUT_MS = 120_000;

const CORE_CAPABILITIES: ToolCapability[] = CORE_TOOL_DEFINITIONS.flatMap((definition) => {
  const name = definition.function?.name;
  return name
    ? [{ name, description: definition.function?.description ?? '', category: 'workspace' }]
    : [];
});

export function coreToolCapabilities(): AgentCapabilityRegistration {
  return {
    id: 'core',
    capabilities: CORE_CAPABILITIES,
    create: async (context) => {
      const workspace = new Workspace();
      if (context.workspace) {
        await Effect.runPromise(
          Effect.tryPromise({
            try: () => workspace.select(context.workspace!.path),
            catch: (error) => error,
          }).pipe(Effect.timeout(WORKSPACE_SELECT_TIMEOUT_MS)),
        );
      }
      const enabledTools = expandCoreToolNames(context.enabledTools);
      const registration = createCoreToolRegistration({
        workspace,
        policy: context.policy,
        enabledTools,
        checkpoints: Array.isArray(context.recoveryState)
          ? context.recoveryState as SerializedToolCheckpoint[]
          : [],
        approval: (descriptor) => context.requestApproval(descriptor),
        onAudit: (record) => context.audit('context', { type: 'audit', source: 'core', ...record }),
        onTodo: (payload) => context.audit('todo', payload),
      });
      return {
        definitions: registration.definitions.filter((definition) => {
          const name = definition.function?.name;
          return name !== undefined && enabledTools.has(name);
        }),
        execute: async (name, args, execution) => {
          const result = await Effect.runPromise(
            Effect.tryPromise({
              try: () => registration.execute(name, args, { signal: execution.signal }),
              catch: (error) => error,
            }).pipe(Effect.timeout(INTEGRATION_TIMEOUT_MS)),
          );
          return {
            ok: true,
            output: result.content,
            diff: result.diff,
            checkpointId: result.checkpointId,
          };
        },
        undo: async (checkpointId, execution) => {
          const result = await Effect.runPromise(
            Effect.tryPromise({
              try: () => registration.undo(checkpointId, { signal: execution.signal }),
              catch: (error) => error,
            }).pipe(Effect.timeout(INTEGRATION_TIMEOUT_MS)),
          );
          return { ok: true, output: result.content, diff: result.diff };
        },
        exportState: () => registration.exportCheckpoints(),
      };
    },
  };
}

const INTEGRATION_CAPABILITIES: ToolCapability[] = [
  { name: 'browser_navigate', description: 'Open a web page in an isolated browser.', category: 'browser' },
  { name: 'browser_inspect', description: 'Inspect the isolated browser page.', category: 'browser' },
  { name: 'browser_interact', description: 'Interact with the isolated browser page.', category: 'browser' },
  { name: 'artifact_create', description: 'Create a persistent workspace artifact.', category: 'artifacts' },
  { name: 'artifact_list', description: 'List workspace artifacts.', category: 'artifacts' },
  { name: 'artifact_read', description: 'Read a workspace artifact.', category: 'artifacts' },
  { name: 'mcp', description: 'Use tools discovered from connected MCP servers.', category: 'mcp' },
];

export function integrationCapabilities(runtime: DesktopIntegrationRuntime): AgentCapabilityRegistration {
  return {
    id: 'integrations',
    capabilities: INTEGRATION_CAPABILITIES,
    create: async (context) => {
      const enabledTools = normalizeIntegrationToolNames(context.enabledTools);
      const definitions = await Effect.runPromise(
        Effect.tryPromise({
          try: () => runtime.capabilities.definitions(enabledTools, context.workspace?.path),
          catch: (error) => error,
        }).pipe(Effect.timeout(WORKSPACE_SELECT_TIMEOUT_MS)),
      );
      return {
        definitions,
        execute: async (name, args, execution) => {
          const output = await Effect.runPromise(
            Effect.tryPromise({
              try: () =>
                runtime.capabilities.invoke(name, args, {
                  taskId: context.taskId,
                  workspace: context.workspace?.path ?? '',
                  policy: context.policy,
                  enabledTools,
                  signal: execution.signal,
                  requestApproval: (descriptor) => context.requestApproval(descriptor),
                  audit: (event) => context.audit('context', { type: 'audit', source: 'integration', ...event }),
                }),
              catch: (error) => error,
            }).pipe(Effect.timeout(INTEGRATION_TIMEOUT_MS)),
          );
          return {
            ok: true,
            output,
            ...(name === 'artifact_create' && { artifact: output }),
          };
        },
      };
    },
  };
}

function expandCoreToolNames(enabled: readonly string[]): Set<string> {
  const names = new Set(enabled);
  if (names.has('read')) {
    names.add('read_file');
    names.add('list_directory');
    names.add('git_status');
    names.add('git_diff');
  }
  if (names.has('write')) names.add('write_file');
  if (names.has('bash')) names.add('run_command');
  if (names.has('git')) {
    names.add('git_status');
    names.add('git_diff');
    names.add('git_commit');
  }
  for (const name of [...names]) {
    if (!CORE_TOOL_NAMES.includes(name as (typeof CORE_TOOL_NAMES)[number])) names.delete(name);
  }
  return names;
}

function normalizeIntegrationToolNames(enabled: readonly string[]): string[] {
  const names = new Set(enabled);
  for (const name of enabled) {
    const normalized = name.toLowerCase();
    if (normalized === 'browser') names.add('browser');
    if (normalized === 'artifacts') names.add('artifacts');
    if (normalized === 'apps & mcp' || normalized === 'mcp') names.add('mcp');
  }
  return [...names];
}
