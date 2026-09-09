import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { redactValue } from '../tools/security.js';

/** Append-only control-plane audit log. Task-specific audits live in task event histories. */
export class AuditLog {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(event: unknown): Promise<void> {
    const line = `${JSON.stringify(redactValue(event))}\n`;
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
      await chmod(this.path, 0o600);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
