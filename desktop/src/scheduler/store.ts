import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { PersistedSchedulerState } from './types.js';

const EMPTY_STATE: PersistedSchedulerState = { version: 1, schedules: [], history: {} };

export class ScheduleStore {
  readonly filePath: string;

  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'schedules.json');
  }

  async load(): Promise<PersistedSchedulerState> {
    // Promise boundary: internals are an Effect program (typed IO errors),
    // the public signature stays Promise-based for runtime.ts callers.
    return Effect.runPromise(this.loadEffect());
  }

  private loadEffect(): Effect.Effect<PersistedSchedulerState, unknown> {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(self.directory, { recursive: true }),
        catch: (error) => error,
      });
      const source: string | null = yield* Effect.tryPromise({
        try: () => readFile(self.filePath, 'utf8'),
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          isMissingFile(error) ? Effect.succeed<string | null>(null) : Effect.fail(error),
        ),
      );
      if (source === null) return structuredClone(EMPTY_STATE);
      const parsed: unknown = yield* Effect.tryPromise({
        try: () => Promise.resolve(JSON.parse(source)),
        catch: (error) =>
          new Error(
            `Cannot read scheduler state at ${self.filePath}: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });
      if (!isPersistedState(parsed)) {
        return yield* Effect.fail(
          new Error(`Cannot read scheduler state at ${self.filePath}: unsupported or malformed data`),
        );
      }
      return structuredClone(parsed);
    });
  }

  async save(state: PersistedSchedulerState): Promise<void> {
    return Effect.runPromise(this.saveEffect(state));
  }

  private saveEffect(state: PersistedSchedulerState): Effect.Effect<void, unknown> {
    const self = this;
    const snapshot = structuredClone(state);
    return Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(self.directory, { recursive: true }),
        catch: (error) => error,
      });
      const temporaryPath = `${self.filePath}.tmp`;
      // ensuring guarantees the temp file never leaks, even when the fiber
      // is interrupted mid-write (no zombie .tmp files). The release is
      // fire-and-forget (Effect.ignore): unlink failure after a successful
      // rename just means there is nothing left to clean.
      yield* Effect.ensuring(
        Effect.tryPromise({
          try: () =>
            writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
              encoding: 'utf8',
              mode: 0o600,
            }).then(() => rename(temporaryPath, self.filePath)),
          catch: (error) => error,
        }),
        Effect.tryPromise({
          try: () => unlink(temporaryPath).catch(() => undefined),
          catch: (error) => error,
        }).pipe(Effect.ignore),
      );
    });
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
