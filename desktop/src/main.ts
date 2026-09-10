/**
 * Electron entry point. Replaces desktop/main.cjs and the Go binary it used to
 * spawn: the gateway now runs in this process, so there is one language, one
 * build, and no health-check race against a child process.
 */

import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from 'electron';
import type { Server } from 'node:http';
import { basename, join } from 'node:path';
import { buildAppMenuTemplate } from './app-menu.js';
import { AuditLog } from './agent/audit.js';
import { coreToolCapabilities, integrationCapabilities } from './agent/builtins.js';
import { TaskRuntime, type PreparedTaskRequest } from './agent/runtime.js';
import { TaskStore } from './agent/store.js';
import type { AgentTaskRequest, DesktopHttpHandler, WorkspaceSnapshot } from './agent/types.js';
import { loadConfig } from './config/config.js';
import { ensureConfig } from './config/user.js';
import {
  createDesktopIntegrationHttpHandler,
  registerDesktopIntegrations,
  type DesktopIntegrationRuntime,
} from './integrations/index.js';
import { buildProviders } from './providers/factory.js';
import { createProvidersHttpHandler } from './providers/http.js';
import { ProviderRuntime } from './providers/registry.js';
import { createSafeStorageCipher } from './providers/secrets.js';
import { getContentString } from './providers/types.js';
import type { ChatCompletionRequest } from './providers/types.js';
import { createSemanticRouter, type RequestInfo } from './routing/routing.js';
import { createSchedulerHttpHandler, SchedulerRuntime } from './scheduler/index.js';
import { createGatewayServer } from './server/server.js';
import { createSkillsRuntime, type SkillsRuntime } from './skills/index.js';
import { installExternalNavigation } from './navigation.js';
import { Workspace } from './tools/workspace.js';

let server: Server | undefined;
let taskRuntime: TaskRuntime | undefined;
let scheduler: SchedulerRuntime | undefined;
let integrations: DesktopIntegrationRuntime | undefined;
let auditLog: AuditLog | undefined;
let selectedWorkspace: WorkspaceSnapshot | undefined;
let quitting = false;

const resourceRoot = () => (app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..'));

async function start(): Promise<string> {
  const userData = app.getPath('userData');
  const configPath = await ensureConfig(join(resourceRoot(), 'etc', 'config.desktop.yaml'));
  const config = await loadConfig(configPath);
  const { router } = buildProviders(config);
  const workspace = new Workspace();
  const audit = new AuditLog(join(userData, 'audit.jsonl'));
  auditLog = audit;

  const classifierUsesOpenRouter = config.routing?.classifier?.provider === 'open_router';
  const semanticRouter = config.routing
    ? createSemanticRouter(config.routing, {
        classifierBaseUrl: classifierUsesOpenRouter
          ? (config.providers?.open_router?.base_url ?? '')
          : (config.providers?.local?.base_url ?? ''),
        classifierApiKey: classifierUsesOpenRouter ? (config.providers?.open_router?.api_key ?? '') : '',
      })
    : undefined;
  const resolveModel = semanticRouter
    ? async (request: ChatCompletionRequest) => (await semanticRouter.route(toRequestInfo(request))).model
    : undefined;

  const skills = createSkillsRuntime({ configPath: join(userData, 'skills.json') });
  const integrationRuntime = registerDesktopIntegrations({
    workspace: () => selectedWorkspace?.path ?? null,
    mcpConfigPath: join(userData, 'mcp-servers.json'),
    audit: (event) => audit.append({ source: 'integrations', ...event }),
  });
  integrations = integrationRuntime;

  const runtime = new TaskRuntime({
    router,
    store: new TaskStore(join(userData, 'tasks')),
    defaultWorkspace: () => selectedWorkspace && { ...selectedWorkspace },
    ...(resolveModel && { resolveModel }),
    registrations: [
      coreToolCapabilities(),
      integrationCapabilities(integrationRuntime),
    ],
    prepareRequest: async (request) => prepareTaskWithSkills(request, skills, selectedWorkspace),
  });
  taskRuntime = runtime;
  await runtime.initialize();

  const schedulerRuntime = await SchedulerRuntime.open({
    directory: join(userData, 'scheduler'),
    dispatcher: runtime,
    onError: (error) => {
      void audit.append({
        source: 'scheduler',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
  scheduler = schedulerRuntime;
  await schedulerRuntime.start();

  // Built after app.whenReady(): safeStorage needs the keychain, which Linux
  // does not offer before then.
  const providerRuntime = await ProviderRuntime.open({
    directory: userData,
    router,
    cipher: createSafeStorageCipher(safeStorage),
    configIds: router.instances().map((instance) => instance.id),
  });

  const integrationHandler = createDesktopIntegrationHttpHandler(integrationRuntime.control);
  const handlers: DesktopHttpHandler[] = [
    ({ request, response, url }) => skills.handleRequest(request, response, url),
    createSchedulerHttpHandler(schedulerRuntime),
    createProvidersHttpHandler(providerRuntime),
    ({ request, response, url }) => integrationHandler(request, response, url),
  ];

  server = createGatewayServer({
    router,
    webRoot: app.isPackaged ? join(process.resourcesPath, 'web') : join(resourceRoot(), 'gateway', 'web'),
    ...(resolveModel && { resolveModel }),
    desktop: {
      runtime,
      handlers,
      selectWorkspace: async () => {
        const selection = await dialog.showOpenDialog({
          title: 'Select a project folder',
          properties: ['openDirectory', 'createDirectory'],
        });
        const path = selection.filePaths[0];
        if (selection.canceled || !path) return undefined;
        const realPath = await workspace.select(path);
        selectedWorkspace = { path: realPath, name: basename(realPath) };
        await audit.append({
          source: 'workspace',
          timestamp: new Date().toISOString(),
          operation: 'select',
          workspace: selectedWorkspace,
        });
        return { ...selectedWorkspace };
      },
    },
  });

  const [host, port] = splitListen(config.listen);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(port, host, resolve);
  });
  return `http://${host}:${port}/`;
}

async function prepareTaskWithSkills(
  request: AgentTaskRequest,
  skills: SkillsRuntime,
  fallbackWorkspace?: WorkspaceSnapshot,
): Promise<PreparedTaskRequest> {
  const workspace = request.workspace ?? fallbackWorkspace;
  const resolved = await skills.resolveInstructions({
    workspace: workspace?.path,
    threadId: request.threadId,
    enabledSkillIds: request.enabledSkillIds,
  });
  const enabledSkillIds = request.enabledSkillIds ?? [
    ...resolved.enabledSkills.map((skill) => skill.id),
    ...resolved.unavailableSkillIds,
  ];
  const prompts = [request.systemPrompt?.trim(), resolved.systemPrompt.trim()].filter(Boolean);
  return {
    request: {
      ...request,
      enabledSkillIds,
      systemPrompt: prompts.join('\n\n'),
      ...(workspace && { workspace }),
    },
    context: {
      type: 'skills',
      enabledSkills: resolved.enabledSkills,
      unavailableSkillIds: resolved.unavailableSkillIds,
    },
  };
}

/**
 * `model` is left unset: the cascade passes an explicit model straight through,
 * and the server only asks for a decision when the client sent none or `auto`.
 */
function toRequestInfo(req: ChatCompletionRequest): RequestInfo {
  return {
    messages: req.messages.map((message) => ({
      role: message.role,
      content: getContentString(message),
    })),
    ...(req.max_tokens !== undefined && { maxTokens: req.max_tokens }),
    hasTools: (req.tools?.length ?? 0) > 0,
  };
}

function splitListen(listen: string): [string, number] {
  const index = listen.lastIndexOf(':');
  if (index === -1) return ['127.0.0.1', Number(listen)];
  return [listen.slice(0, index) || '127.0.0.1', Number(listen.slice(index + 1))];
}

function createWindow(url: string): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 540,
    title: 'TAWX Desktop',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });
  installExternalNavigation(window.webContents, url, (externalUrl) => shell.openExternal(externalUrl));
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(
    app.name,
    process.platform === 'darwin',
    (command) => {
      if (!window.isDestroyed()) window.webContents.send('app-command', command);
    },
  )));
  window.maximize();
  void window.loadURL(url);
}

void app.whenReady().then(async () => {
  try {
    createWindow(await start());
  } catch (error) {
    dialog.showErrorBox(
      'TAWX Desktop could not start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void shutdown().finally(() => app.exit(0));
});

async function shutdown(): Promise<void> {
  server?.close();
  server?.closeAllConnections();
  await Promise.allSettled([scheduler?.stop()]);
  await Promise.allSettled([taskRuntime?.shutdown()]);
  await Promise.allSettled([integrations?.close()]);
  await auditLog?.flush();
}
