import assert from 'node:assert/strict';
import test from 'node:test';
import { readProject } from '../src/lib/project.ts';

test('readProject includes the tree and useful project files', async () => {
  const files = [
    { name: 'README.md', webkitRelativePath: 'demo/README.md', text: async () => '# Demo app' },
    { name: 'main.ts', webkitRelativePath: 'demo/src/main.ts', text: async () => 'ignored' },
    { name: 'package.json', webkitRelativePath: 'demo/node_modules/pkg/package.json', text: async () => 'dependency noise' },
  ] as File[];
  const project = await readProject(files);

  assert.equal(project.name, 'demo');
  assert.equal(project.fileCount, 2);
  assert.equal(project.hasOverview, true);
  assert.match(project.context, /demo\/src\/main\.ts/);
  assert.match(project.context, /# Demo app/);
  assert.doesNotMatch(project.context, /ignored/);
  assert.doesNotMatch(project.context, /dependency noise|node_modules/);
});

test('readProject marks a config-only folder as insufficient', async () => {
  const project = await readProject([
    { name: 'config.yaml', webkitRelativePath: 'tawx-desktop/config.yaml', text: async () => 'models: []' },
  ] as File[]);

  assert.equal(project.hasOverview, false);
  assert.match(project.context, /Do not infer/);
});
