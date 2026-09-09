import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type SkillConfigurationScope = 'project' | 'thread';

export interface SkillSelectionQuery {
  workspace?: string;
  threadId?: string;
  scope: SkillConfigurationScope;
}

export interface StoredSkillSelection {
  enabledSkillIds: string[];
  inherited: boolean;
}

export interface SkillSelectionUpdate extends SkillSelectionQuery {
  enabledSkillIds: string[];
  inheritProject?: boolean;
}

interface ProjectSelection {
  workspace: string;
  enabledSkillIds: string[];
}

interface ThreadSelection extends ProjectSelection {
  threadId: string;
}

interface SkillConfigurationFile {
  version: 1;
  projects: ProjectSelection[];
  threads: ThreadSelection[];
}

const EMPTY_CONFIGURATION: SkillConfigurationFile = { version: 1, projects: [], threads: [] };
const GLOBAL_WORKSPACE = '$global';
const MAX_CONFIG_BYTES = 512 * 1024;

export class SkillConfigurationStore {
  readonly #path: string;
  #updateQueue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async read(query: SkillSelectionQuery): Promise<StoredSkillSelection> {
    validateQuery(query);
    const config = await this.#readFile();
    return selectionFrom(config, query);
  }

  update(input: SkillSelectionUpdate): Promise<StoredSkillSelection> {
    validateQuery(input);
    const enabledSkillIds = validateSkillIds(input.enabledSkillIds);

    const operation = this.#updateQueue.then(async () => {
      const config = await this.#readFile();
      const workspace = input.workspace || GLOBAL_WORKSPACE;

      if (input.scope === 'project') {
        config.projects = config.projects.filter((entry) => entry.workspace !== workspace);
        config.projects.push({ workspace, enabledSkillIds });
      } else if (input.inheritProject) {
        config.threads = config.threads.filter((entry) => entry.threadId !== input.threadId);
      } else {
        config.threads = config.threads.filter((entry) => entry.threadId !== input.threadId);
        config.threads.push({ workspace, threadId: input.threadId!, enabledSkillIds });
      }

      await this.#writeFile(config);
      return selectionFrom(config, input);
    });

    this.#updateQueue = operation.catch(() => undefined);
    return operation;
  }

  async #readFile(): Promise<SkillConfigurationFile> {
    let handle;
    try {
      handle = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) {
        throw new Error('skill configuration is not a safe regular file');
      }
      const raw = await handle.readFile({ encoding: 'utf8' });
      return parseConfiguration(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { ...EMPTY_CONFIGURATION, projects: [], threads: [] };
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async #writeFile(config: SkillConfigurationFile): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, this.#path);
      await chmod(this.#path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function selectionFrom(config: SkillConfigurationFile, query: SkillSelectionQuery): StoredSkillSelection {
  const workspace = query.workspace || GLOBAL_WORKSPACE;
  if (query.scope === 'thread') {
    const thread = config.threads.find((entry) => entry.threadId === query.threadId && entry.workspace === workspace);
    if (thread) return { enabledSkillIds: [...thread.enabledSkillIds], inherited: false };
  }

  const project = config.projects.find((entry) => entry.workspace === workspace);
  return { enabledSkillIds: [...(project?.enabledSkillIds ?? [])], inherited: query.scope === 'thread' };
}

function validateQuery(query: SkillSelectionQuery): void {
  if (query.scope !== 'project' && query.scope !== 'thread') throw new Error('scope must be project or thread');
  if (query.scope === 'thread' && (!query.threadId || query.threadId.length > 200)) {
    throw new Error('threadId is required for thread scope');
  }
  if (query.workspace && query.workspace.length > 4096) throw new Error('workspace path is too long');
}

function validateSkillIds(value: readonly unknown[]): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('enabledSkillIds must be an array with at most 128 entries');
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !/^skill_[a-f0-9]{20}$/.test(item)) throw new Error('enabledSkillIds contains an invalid skill id');
    ids.add(item);
  }
  return [...ids];
}

function parseConfiguration(value: unknown): SkillConfigurationFile {
  if (!value || typeof value !== 'object') throw new Error('skill configuration is invalid');
  const candidate = value as Partial<SkillConfigurationFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.projects) || !Array.isArray(candidate.threads)) {
    throw new Error('skill configuration version is not supported');
  }

  const projects: ProjectSelection[] = [];
  for (const entry of candidate.projects) {
    if (!entry || typeof entry.workspace !== 'string' || !Array.isArray(entry.enabledSkillIds)) {
      throw new Error('project skill configuration is invalid');
    }
    projects.push({ workspace: entry.workspace, enabledSkillIds: validateSkillIds(entry.enabledSkillIds) });
  }

  const threads: ThreadSelection[] = [];
  for (const entry of candidate.threads) {
    if (!entry || typeof entry.workspace !== 'string' || typeof entry.threadId !== 'string' || !Array.isArray(entry.enabledSkillIds)) {
      throw new Error('thread skill configuration is invalid');
    }
    threads.push({
      workspace: entry.workspace,
      threadId: entry.threadId,
      enabledSkillIds: validateSkillIds(entry.enabledSkillIds),
    });
  }

  return { version: 1, projects, threads };
}
