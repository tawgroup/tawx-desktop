const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const url = 'http://127.0.0.1:18080/';
let gateway;

function isReady() {
  return new Promise((resolve) => {
    const request = http.get(`${url}health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await isReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Gateway did not start. Check that OMP is installed and signed in.');
}

function startGateway() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const script = path.join(resources, 'scripts', 'run-with-omp');
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
    ...(app.isPackaged ? { TAWX_DESKTOP_BIN: path.join(resources, 'tawx-desktop') } : {}),
  };
  gateway = spawn('/bin/bash', [script], { cwd: resources, env });
  gateway.stdout.pipe(process.stdout);
  gateway.stderr.pipe(process.stderr);
}

function createWindow() {
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

app.whenReady().then(async () => {
  startGateway();
  try {
    await waitForGateway();
    createWindow();
  } catch (error) {
    dialog.showErrorBox('TAWX Desktop could not start', error.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => gateway?.kill('SIGTERM'));
