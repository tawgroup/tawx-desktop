/**
 * Electron entry point. Replaces desktop/main.cjs and the Go binary it used to
 * spawn: the gateway now runs in this process, so there is one language, one
 * build, and no health-check race against a child process.
 */

import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig } from './config/config.js';
import { ensureConfig, startOmp, type OmpSession } from './config/omp.js';
import { buildProviders } from './providers/factory.js';
import { createSemanticRouter, type RequestInfo } from './routing/routing.js';
import { createGatewayServer } from './server/server.js';
import { Toolbox } from './tools/tools.js';
import { Workspace } from './tools/workspace.js';
import { getContentString } from './providers/types.js';
import type { ChatCompletionRequest } from './providers/types.js';

let server: Server | undefined;
let omp: OmpSession | undefined;

const resourceRoot = () => (app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..'));

async function start(): Promise<string> {
  omp = await startOmp();

  // the config's ${OMP_*} placeholders are resolved from the environment, so
  // the values OMP just handed us have to land there before it is parsed
  Object.assign(process.env, omp.roleModels, {
    OMP_AUTH_GATEWAY_URL: omp.authGatewayUrl,
    OPENROUTER_API_KEY: omp.openRouterApiKey,
  });

  const configPath = await ensureConfig(join(resourceRoot(), 'etc', 'config.omp.yaml'));
  const config = await loadConfig(configPath);
  const { router } = buildProviders(config);

  const workspace = new Workspace();
  const toolbox = new Toolbox(workspace);
  void toolbox; // wired to the UI in the next step

  // the UI sends `auto` by default, so without this the gateway would reject
  // every request the app itself makes
  const semanticRouter = config.routing
    ? createSemanticRouter(config.routing, {
        classifierBaseUrl: config.providers?.local?.base_url ?? '',
      })
    : undefined;

  server = createGatewayServer({
    router,
    webRoot: app.isPackaged ? join(process.resourcesPath, 'web') : join(resourceRoot(), 'gateway', 'web'),
    ...(semanticRouter && {
      resolveModel: async (req: ChatCompletionRequest) => (await semanticRouter.route(toRequestInfo(req))).model,
    }),
  });

  const [host, port] = splitListen(config.listen);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(port, host, resolve);
  });

  return `http://${host}:${port}/`;
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
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
app.on('before-quit', () => {
  server?.close();
  omp?.stop();
});
