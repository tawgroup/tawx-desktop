import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuditLog } from './audit.js';

test('audit log redacts credentials and private keys before persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-audit-'));
  const path = join(directory, 'audit.jsonl');
  const audit = new AuditLog(path);

  try {
    await audit.append({
      command: 'TOKEN=audit-secret command',
      password: 'plain-password',
      url: 'https://user:url-password@example.com/private',
      privateKey: '-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----',
    });
    await audit.flush();
    const persisted = await readFile(path, 'utf8');
    assert.doesNotMatch(persisted, /audit-secret|plain-password|url-password|private-key-material/);
    assert.match(persisted, /\[REDACTED\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
