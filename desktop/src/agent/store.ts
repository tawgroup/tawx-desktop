import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { PersistedTask } from './types.js';

const TASK_FILE_MAX_BYTES = 128 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Durable JSON storage with serialized, atomic replacements per process. */
export class TaskStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async load(): Promise<PersistedTask[]> {
    // Promise boundary: directory scan runs as an Effect program; per-file
    // reads keep the old skip-on-corrupt behavior via catchAll.
    return Effect.runPromise(this.loadEffect());
  }

  private loadEffect(): Effect.Effect<PersistedTask[], unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(self.directory, { recursive: true }),
        catch: (error) => error,
      });
      const entries = yield* Effect.tryPromise({
        try: () => readdir(self.directory, { withFileTypes: true }),
        catch: (error) => error,
      });
      const tasks: PersistedTask[] = [];
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.tryPromise({
            try: () => self.readOne(join(self.directory, entry.name), entry.name, entry.isFile()),
            catch: () => undefined,
          }).pipe(
            Effect.flatMap((task) => Effect.sync(() => {
              if (task) tasks.push(task);
            })),
            Effect.orElseSucceed(() => undefined),
          ),
        { concurrency: 'unbounded', discard: true },
      );
      return tasks;
    });
  }

  private async readOne(path: string, fileName: string, isFile: boolean): Promise<PersistedTask | undefined> {
    if (!isFile || !fileName.endsWith('.json')) return undefined;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > TASK_FILE_MAX_BYTES) return undefined;
      const value = JSON.parse(await handle.readFile('utf8')) as unknown;
      if (isPersistedTask(value) && fileName === `${value.id}.json`) return value;
      return undefined;
    } catch {
      // An unsafe or corrupt task must not prevent recovery of every other thread.
      return undefined;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  save(task: PersistedTask): Promise<void> {
    if (!isSafeTaskId(task.id)) throw new Error('Task id must be a UUID.');
    const snapshot = JSON.stringify(task);
    if (Buffer.byteLength(snapshot, 'utf8') > TASK_FILE_MAX_BYTES) {
      throw new Error(`Task snapshot exceeds ${TASK_FILE_MAX_BYTES} bytes.`);
    }
    const finalPath = join(this.directory, `${task.id}.json`);
    const temporaryPath = join(this.directory, `.${task.id}.${randomUUID()}.tmp`);
    // The serialized writes-chain is preserved (one atomic replace at a
    // time per process); each link is now an Effect with ensuring cleanup
    // of the temp file — no zombie .tmp files on interruption.
    const write = (): Promise<void> =>
      Effect.runPromise(
        Effect.ensuring(
          Effect.tryPromise({
            try: () =>
              mkdir(this.directory, { recursive: true })
                .then(() => writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' }))
                .then(() => rename(temporaryPath, finalPath)),
            catch: (error) => error,
          }),
          Effect.tryPromise({
            try: () => unlink(temporaryPath).catch(() => undefined),
            catch: (error) => error,
          }).pipe(Effect.ignore),
        ),
      );
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
