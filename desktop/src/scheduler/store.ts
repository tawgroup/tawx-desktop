import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedSchedulerState } from './types.js';

const EMPTY_STATE: PersistedSchedulerState = { version: 1, schedules: [], history: {} };

export class ScheduleStore {
  readonly filePath: string;

  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'schedules.json');
  }

  async load(): Promise<PersistedSchedulerState> {
    await mkdir(this.directory, { recursive: true });
    let source: string;
    try {
      source = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(EMPTY_STATE);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`Cannot read scheduler state at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isPersistedState(parsed)) {
      throw new Error(`Cannot read scheduler state at ${this.filePath}: unsupported or malformed data`);
    }
    return structuredClone(parsed);
  }

  async save(state: PersistedSchedulerState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isPersistedState(value: unknown): value is PersistedSchedulerState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedSchedulerState>;
  return candidate.version === 1 && Array.isArray(candidate.schedules) && Boolean(candidate.history) && typeof candidate.history === 'object';
}
