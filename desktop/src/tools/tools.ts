/**
 * Agent tools scoped to the selected project folder.
 *
 * This is the layer Electron makes possible: the Go gateway never had
 * filesystem access, and the browser could only ever hand over a truncated
 * snapshot of the picked folder. Everything here runs in the Electron main
 * process, so it reads real files — which is exactly why every path goes
 * through Workspace and every mutating call goes through the policy gate.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { Workspace, WorkspaceError } from './workspace.js';

export type ToolAccess = 'allow' | 'ask' | 'deny';

export interface ToolPolicy {
  read: ToolAccess;
  write: ToolAccess;
  bash: ToolAccess;
}

/** Matches the defaults the Cowork hub already persists for these three tools. */
export const DEFAULT_POLICY: ToolPolicy = { read: 'allow', write: 'ask', bash: 'ask' };

export interface ApprovalRequest {
  tool: keyof ToolPolicy;
  /** What the user is being asked to permit, in their terms. */
  detail: string;
}

export type Approver = (request: ApprovalRequest) => Promise<boolean>;

export class ToolDenied extends Error {
  constructor(tool: string) {
    super(`the ${tool} tool was not permitted for this request`);
    this.name = 'ToolDenied';
  }
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 100_000;
const BASH_TIMEOUT_MS = 120_000;

export interface DirEntry {
  path: string;
  type: 'file' | 'directory';
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class Toolbox {
  constructor(
    private readonly workspace: Workspace,
    private policy: ToolPolicy = { ...DEFAULT_POLICY },
    /** Denies by default: an unwired UI must not silently grant write access. */
    private readonly approve: Approver = async () => false,
  ) {}

  setPolicy(policy: Partial<ToolPolicy>): void {
    this.policy = { ...this.policy, ...policy };
  }

  getPolicy(): ToolPolicy {
    return { ...this.policy };
  }

  private async gate(tool: keyof ToolPolicy, detail: string): Promise<void> {
    const access = this.policy[tool];
    if (access === 'allow') return;
    if (access === 'deny') throw new ToolDenied(tool);
    if (!(await this.approve({ tool, detail }))) throw new ToolDenied(tool);
  }

  async readTextFile(path: string): Promise<string> {
    await this.gate('read', `Read ${path}`);
    const resolved = await this.workspace.resolveInside(path);

    const info = await stat(resolved);
    if (info.isDirectory()) throw new WorkspaceError(`${path} is a directory`);
    if (info.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(`${path} is ${info.size} bytes, over the ${MAX_FILE_BYTES} byte tool limit`);
    }
    return readFile(resolved, 'utf8');
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.gate('write', `Write ${path} (${content.length} characters)`);
    const resolved = await this.workspace.resolveInside(path);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf8');
  }

  /** Lists one directory level, with paths relative to the project root. */
  async listDirectory(path = '.'): Promise<DirEntry[]> {
    await this.gate('read', `List ${path}`);
    const resolved = await this.workspace.resolveInside(path);
    const root = this.workspace.selected ?? resolved;

    const entries = await readdir(resolved, { withFileTypes: true });
    return entries.map((entry) => ({
      path: relative(root, `${resolved}/${entry.name}`),
      type: entry.isDirectory() ? 'directory' : 'file',
    }));
  }

  /**
   * Runs a command with the project folder as the working directory. Output is
   * capped and the process is killed on timeout so a runaway build cannot wedge
   * the app or flood the model's context.
   */
  async runBash(command: string): Promise<BashResult> {
    await this.gate('bash', `Run: ${command}`);

    const cwd = this.workspace.selected;
    if (!cwd) throw new WorkspaceError('no project folder selected');

    return new Promise<BashResult>((resolve, reject) => {
      const child = spawn('/bin/bash', ['-c', command], { cwd, env: process.env });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, BASH_TIMEOUT_MS);
      timer.unref();

      const capture = (target: 'out' | 'err') => (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (target === 'out') {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        } else if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += text;
        }
      };

      child.stdout.on('data', capture('out'));
      child.stderr.on('data', capture('err'));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
          exitCode,
          timedOut,
        });
      });
    });
  }
}
