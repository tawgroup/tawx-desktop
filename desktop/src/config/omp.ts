/**
 * OMP integration. Ported from scripts/run-with-omp.
 *
 * The shell script resolved model roles with jq, started two OMP side-processes
 * and then exec'd the Go binary. Here the gateway is in-process, so this module
 * only has to do the first two jobs — and the jq dependency disappears.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const BROKER_BIND = process.env.ROUTELLM_BROKER_BIND ?? '127.0.0.1:19100';
const AUTH_BIND = process.env.ROUTELLM_AUTH_BIND ?? '127.0.0.1:19101';
const READY_ATTEMPTS = 50;
const READY_DELAY_MS = 100;

/** PATH additions so a GUI-launched app still finds a Homebrew-installed omp. */
const OMP_PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`;

export interface OmpSession {
  authGatewayUrl: string;
  openRouterApiKey: string;
  /** Model selector per router role, ready to be exported as OMP_ROUTER_*. */
  roleModels: Record<string, string>;
  stop: () => void;
}

interface OmpModel {
  id?: string;
  selector?: string;
}

async function omp(args: string[]): Promise<string> {
  const { stdout } = await run('omp', args, { env: { ...process.env, PATH: OMP_PATH } });
  return stdout.trim();
}

/**
 * Maps each router role onto a concrete model selector. A role's configured
 * value may be either a selector or a model id, so both are matched — the same
 * two-step lookup the jq expression did.
 */
export async function resolveRoleModels(): Promise<Record<string, string>> {
  const roles = JSON.parse(await omp(['config', 'get', 'modelRoles', '--json'])) as {
    value?: Record<string, string>;
  };
  const models = JSON.parse(await omp(['models', '--json'])) as { models?: OmpModel[] };
  const available = models.models ?? [];

  const resolve = (role: string): string => {
    const value = roles.value?.[role];
    if (!value) return '';
    const match =
      available.find((model) => model.selector === value) ?? available.find((model) => model.id === value);
    return match?.selector ?? '';
  };

  return {
    OMP_ROUTER_CLASSIFIER_MODEL: resolve('smol'),
    OMP_ROUTER_FAST_MODEL: resolve('default'),
    OMP_ROUTER_CODING_MODEL: resolve('main'),
    OMP_ROUTER_REASONING_MODEL: resolve('slow'),
    OMP_ROUTER_CREATIVE_MODEL: resolve('main'),
    OMP_ROUTER_GENERAL_MODEL: resolve('default'),
  };
}

/** Copies the bundled config into place on first run, as the script did. */
export async function ensureConfig(bundledConfigPath: string): Promise<string> {
  const configDir = process.env.TAWX_DESKTOP_HOME ?? join(homedir(), 'tawx-desktop');
  const configPath = process.env.TAWX_DESKTOP_CONFIG ?? join(configDir, 'config.yaml');

  try {
    await access(configPath);
    return configPath;
  } catch {
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    const legacy = join(homedir(), 'taw-cowork', 'config.yaml');
    let source = bundledConfigPath;
    try {
      await access(legacy);
      source = legacy;
    } catch {
      // no legacy config; the bundled one it is
    }

    await copyFile(source, configPath);
    await chmod(configPath, 0o600);
    return configPath;
  }
}

/** Starts the OMP auth broker and auth gateway, waiting for each to answer. */
export async function startOmp(): Promise<OmpSession> {
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const child of children) child.kill('SIGTERM');
  };

  try {
    const roleModels = await resolveRoleModels();
    const openRouterApiKey = await omp(['token', 'openrouter']);

    const brokerUrl = `http://${BROKER_BIND}`;
    const authGatewayUrl = `http://${AUTH_BIND}`;

    children.push(spawnOmp(['auth-broker', 'serve', `--bind=${BROKER_BIND}`]));
    const brokerToken = await omp(['auth-broker', 'token']);
    await waitForReady(`${brokerUrl}/`, { Authorization: `Bearer ${brokerToken}` }, 'OMP auth broker');

    children.push(
      spawnOmp(['auth-gateway', 'serve', '--no-auth', `--bind=${AUTH_BIND}`], {
        OMP_AUTH_BROKER_URL: brokerUrl,
        OMP_AUTH_BROKER_TOKEN: brokerToken,
      }),
    );
    await waitForReady(`${authGatewayUrl}/v1/models`, {}, 'OMP auth gateway');

    return { authGatewayUrl, openRouterApiKey, roleModels, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

function spawnOmp(args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn('omp', args, {
    env: { ...process.env, PATH: OMP_PATH, ...extraEnv },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', (err) => console.error(`omp ${args[0]} failed to start:`, err.message));
  return child;
}

async function waitForReady(url: string, headers: Record<string, string>, label: string): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(READY_DELAY_MS * 5) });
      if (res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS).unref());
  }
  throw new Error(`${label} did not start at ${url}`);
}
