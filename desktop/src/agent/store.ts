import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedTask } from './types.js';

const TASK_FILE_MAX_BYTES = 128 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Durable JSON storage with serialized, atomic replacements per process. */
export class TaskStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async load(): Promise<PersistedTask[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const tasks: PersistedTask[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.directory, entry.name);
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > TASK_FILE_MAX_BYTES) continue;
        const value = JSON.parse(await handle.readFile('utf8')) as unknown;
        if (isPersistedTask(value) && entry.name === `${value.id}.json`) tasks.push(value);
      } catch {
        // An unsafe or corrupt task must not prevent recovery of every other thread.
      } finally {
        if (handle) await handle.close().catch(() => undefined);
      }
    }
    return tasks;
  }

  save(task: PersistedTask): Promise<void> {
    if (!isSafeTaskId(task.id)) throw new Error('Task id must be a UUID.');
    const snapshot = JSON.stringify(task);
    if (Buffer.byteLength(snapshot, 'utf8') > TASK_FILE_MAX_BYTES) {
      throw new Error(`Task snapshot exceeds ${TASK_FILE_MAX_BYTES} bytes.`);
    }
    const finalPath = join(this.directory, `${task.id}.json`);
    const temporaryPath = join(this.directory, `.${task.id}.${randomUUID()}.tmp`);
    const write = async (): Promise<void> => {
      await mkdir(this.directory, { recursive: true });
      try {
        await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporaryPath, finalPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}

function isSafeTaskId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPersistedTask(value: unknown): value is PersistedTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<PersistedTask>;
  return isSafeTaskId(task.id)
    && !!task.request
    && typeof task.request === 'object'
    && typeof task.request.threadId === 'string'
    && Array.isArray(task.request.messages)
    && Array.isArray(task.conversation)
    && Array.isArray(task.events)
    && Array.isArray(task.checkpoints)
    && typeof task.createdAt === 'string'
    && typeof task.updatedAt === 'string'
    && (
      task.state === 'planning'
      || task.state === 'running'
      || task.state === 'waiting_approval'
      || task.state === 'completed'
      || task.state === 'failed'
      || task.state === 'cancelled'
    );
}
