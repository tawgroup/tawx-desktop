import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, WorkspaceError } from './workspace.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'tawx-ws-'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(join(project, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(project, 'src', 'index.ts'), 'export {};');
  await writeFile(join(outside, 'secrets.env'), 'TOKEN=s3cret');
  return { base, project, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('resolves a path inside the project', async () => {
  const fx = await fixture();
  try {
    const workspace = new Workspace();
    await workspace.select(fx.project);
    const resolved = await workspace.resolveInside('src/index.ts');
    assert.ok(resolved.endsWith(join('project', 'src', 'index.ts')));
  } finally {
    await fx.cleanup();
  }
});

test('allows a file that does not exist yet', async () => {
  const fx = await fixture();
  try {
    const workspace = new Workspace();
    await workspace.select(fx.project);
    const resolved = await workspace.resolveInside('src/new/deeply/nested.ts');
    assert.ok(resolved.includes('nested.ts'));
  } finally {
    await fx.cleanup();
  }
});

test('rejects traversal out of the project', async () => {
  const fx = await fixture();
  try {
    const workspace = new Workspace();
    await workspace.select(fx.project);
    await assert.rejects(() => workspace.resolveInside('../outside/secrets.env'), WorkspaceError);
    await assert.rejects(() => workspace.resolveInside('src/../../outside/secrets.env'), WorkspaceError);
  } finally {
    await fx.cleanup();
  }
});

test('rejects an absolute path outside the project', async () => {
  const fx = await fixture();
  try {
    const workspace = new Workspace();
    await workspace.select(fx.project);
    await assert.rejects(() => workspace.resolveInside(join(fx.outside, 'secrets.env')), WorkspaceError);
  } finally {
    await fx.cleanup();
  }
});

// string prefixing would accept this: "/tmp/x/projectevil" starts with "/tmp/x/project"
test('rejects a sibling folder whose name extends the project name', async () => {
  const fx = await fixture();
  try {
    await mkdir(`${fx.project}evil`, { recursive: true });
    await writeFile(join(`${fx.project}evil`, 'loot.txt'), 'loot');

    const workspace = new Workspace();
    await workspace.select(fx.project);
    await assert.rejects(() => workspace.resolveInside(join(`${fx.project}evil`, 'loot.txt')), WorkspaceError);
  } finally {
    await fx.cleanup();
  }
});

test('rejects a symlink that points out of the project', async () => {
  const fx = await fixture();
  try {
    await symlink(join(fx.outside, 'secrets.env'), join(fx.project, 'link.env'));

    const workspace = new Workspace();
    await workspace.select(fx.project);
    await assert.rejects(() => workspace.resolveInside('link.env'), WorkspaceError);
  } finally {
    await fx.cleanup();
  }
});

test('refuses every path until a project is selected', async () => {
  await assert.rejects(() => new Workspace().resolveInside('anything'), WorkspaceError);
});

test('selecting a missing folder fails', async () => {
  await assert.rejects(() => new Workspace().select('/definitely/not/here'), WorkspaceError);
});
