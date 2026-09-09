import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './store.js';
import { ArtifactAdapter } from './adapter.js';
import {
  CapabilityRegistry,
  type CapabilityApprovalRequest,
  type CapabilityContext,
} from '../integrations/capabilities.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'tawx-artifacts-'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(project);
  await mkdir(outside);
  return { base, project, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('creates a project-scoped text artifact with bounded preview metadata', async () => {
  const fx = await fixture();
  try {
    const store = new ArtifactStore();
    const artifact = await store.create(fx.project, {
      path: 'reports/summary.md',
      content: '# Summary\n\nComplete.',
    });

    assert.equal(await readFile(join(fx.project, '.tawx', 'artifacts', 'reports', 'summary.md'), 'utf8'), '# Summary\n\nComplete.');
    assert.equal(artifact.path, 'reports/summary.md');
    assert.equal(artifact.mimeType, 'text/markdown');
    assert.deepEqual(artifact.preview, { kind: 'text', content: '# Summary\n\nComplete.', truncated: false });
    assert.deepEqual((await store.list(fx.project)).map((item) => item.path), ['reports/summary.md']);
    assert.deepEqual(await store.read(fx.project, artifact.id), artifact);
  } finally {
    await fx.cleanup();
  }
});

test('artifact approval exposes proposed content but redacts embedded credentials', async () => {
  const fx = await fixture();
  try {
    const registry = new CapabilityRegistry();
    registry.register(new ArtifactAdapter());
    let approval: CapabilityApprovalRequest | undefined;
    const context: CapabilityContext = {
      taskId: 'artifact-task',
      workspace: fx.project,
      policy: 'ask',
      enabledTools: ['artifacts'],
      requestApproval: async (request) => {
        approval = request;
        return 'deny';
      },
      audit: () => undefined,
    };
    await assert.rejects(
      () => registry.invoke('artifact_create', {
        path: 'reports/plan.txt',
        content: 'Deployment plan\napi_key=do-not-show',
      }, context),
      /user denied/,
    );
    assert.deepEqual(approval?.input, {
      path: 'reports/plan.txt',
      content: 'Deployment plan\napi_key=[REDACTED]',
    });
  } finally {
    await fx.cleanup();
  }
});

test('rejects traversal and absolute artifact paths', async () => {
  const fx = await fixture();
  try {
    const store = new ArtifactStore();
    await assert.rejects(() => store.create(fx.project, { path: '../outside.txt', content: 'no' }), /invalid segment/);
    await assert.rejects(() => store.create(fx.project, { path: join(fx.outside, 'outside.txt'), content: 'no' }), /must be relative/);
  } finally {
    await fx.cleanup();
  }
});

test('rejects artifact directory symlinks that escape the project', async () => {
  const fx = await fixture();
  try {
    await mkdir(join(fx.project, '.tawx'));
    await symlink(fx.outside, join(fx.project, '.tawx', 'artifacts'));
    const store = new ArtifactStore();
    await assert.rejects(() => store.create(fx.project, { path: 'leak.txt', content: 'no' }), /escapes/);
  } finally {
    await fx.cleanup();
  }
});

test('returns binary metadata without unsafe inline content', async () => {
  const fx = await fixture();
  try {
    const artifact = await new ArtifactStore().create(fx.project, {
      path: 'data/archive.bin',
      content: Buffer.from([0, 1, 2, 3]).toString('base64'),
      encoding: 'base64',
    });
    assert.deepEqual(artifact.preview, { kind: 'binary', content: null, truncated: false });
  } finally {
    await fx.cleanup();
  }
});
