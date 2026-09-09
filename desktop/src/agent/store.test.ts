import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { TaskStore } from './store.js';
import type { PersistedTask } from './types.js';

test('task storage rejects escaping ids and unsafe recovered files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-store-'));
  const outside = join(dirname(directory), `escaped-${randomUUID()}.json`);
  const symlinkTarget = join(dirname(directory), `${randomUUID()}.json`);
  const store = new TaskStore(directory);

  try {
    const escaping = persistedTask(`../${outside.slice(outside.lastIndexOf('/') + 1, -5)}`);
    await assert.rejects(async () => store.save(escaping), /UUID/);
    await assert.rejects(access(outside));

    const filenameId = randomUUID();
    await writeFile(
      join(directory, `${filenameId}.json`),
      JSON.stringify(persistedTask(randomUUID())),
      { mode: 0o600 },
    );
    await writeFile(symlinkTarget, JSON.stringify(persistedTask(randomUUID())), { mode: 0o600 });
    await symlink(symlinkTarget, join(directory, `${randomUUID()}.json`));

    assert.deepEqual(await store.load(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { force: true });
    await rm(symlinkTarget, { force: true });
  }
});

test('task storage writes private files without reusable temporary names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tawx-agent-store-mode-'));
  const store = new TaskStore(directory);
  const task = persistedTask(randomUUID());

  try {
    await store.save(task);
    const names = await readdir(directory);
    assert.deepEqual(names, [`${task.id}.json`]);
    const mode = (await stat(join(directory, `${task.id}.json`))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function persistedTask(id: string): PersistedTask {
  const now = new Date().toISOString();
  return {
    id,
    request: {
      threadId: 'thread',
      mode: 'cowork',
      messages: [{ role: 'user', content: 'Hello' }],
      policy: 'ask',
      enabledTools: [],
    },
    state: 'completed',
    conversation: [{ role: 'user', content: 'Hello' }],
    iteration: 0,
    events: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  };
}
