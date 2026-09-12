import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Effect, Schedule } from 'effect';
import { redactValue } from '../tools/security.js';

/** Append-only control-plane audit log. Task-specific audits live in task event histories. */
export class AuditLog {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(event: unknown): Promise<void> {
    const line = `${JSON.stringify(redactValue(event))}\n`;
    const self = this;
    // Serialized append-chain preserved; each link is an Effect with a
    // short Schedule retry for transient IO, run at this Promise boundary.
    const write = (): Promise<void> =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            mkdir(dirname(self.path), { recursive: true })
              .then(() => appendFile(self.path, line, { encoding: 'utf8', mode: 0o600 }))
              .then(() => chmod(self.path, 0o600)),
          catch: (error) => error,
        }).pipe(Effect.retry(Schedule.recurs(2)), Effect.asVoid),
      );
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
