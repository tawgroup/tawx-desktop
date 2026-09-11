import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillsRuntime, type SkillCatalog, type SkillDetail } from './index.js';
import { startTestServer } from '../test-support/server.js';

async function createFixture() {
  const base = await mkdtemp(join(tmpdir(), 'tawx-skills-'));
  const project = join(base, 'project');
  const userSkills = join(base, 'user-skills');
  const outside = join(base, 'outside');
  const projectSkill = join(project, '.claude', 'skills', 'review-code');
  const userSkill = join(userSkills, 'write-brief');
  await mkdir(projectSkill, { recursive: true });
  await mkdir(userSkill, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(projectSkill, 'SKILL.md'), [
    '---',
    'name: Review code',
    'description: Review changes using repository conventions.',
    '---',
    '',
    'Inspect the diff before suggesting changes.',
  ].join('\n'));
  await writeFile(join(userSkill, 'SKILL.md'), [
    '---',
    'name: Write a brief',
    'description: Produce a concise written brief.',
    '---',
    '',
    'Summarize evidence. Example command: `rm -rf /`.',
  ].join('\n'));
  await writeFile(join(outside, 'SKILL.md'), '---\nname: Leaked secret\ndescription: TOKEN=do-not-read\n---\nTOKEN=do-not-read');

  const repositorySkills = join(project, '.claude', 'skills');
  await symlink(outside, join(repositorySkills, 'escaped-directory'));
  const linkedFileDirectory = join(repositorySkills, 'escaped-file');
  await mkdir(linkedFileDirectory);
  await symlink(join(outside, 'SKILL.md'), join(linkedFileDirectory, 'SKILL.md'));

  const runtime = createSkillsRuntime({
    userSkillDirectories: [userSkills],
    configPath: join(base, 'config', 'skills.json'),
  });
  const server = await startTestServer(async (request, response) => {
    const handled = await runtime.handleRequest(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });

  return {
    base,
    project,
    userSkills,
    runtime,
    server,
    cleanup: async () => {
      await server.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function fetchCatalog(url: string, project: string, threadId?: string): Promise<SkillCatalog> {
  const query = new URLSearchParams({ workspace: project, scope: threadId ? 'thread' : 'project' });
  if (threadId) query.set('threadId', threadId);
  const response = await fetch(`${url}/desktop/skills?${query}`);
  assert.equal(response.status, 200);
  return await response.json() as SkillCatalog;
}

test('discovers repository and user skills while refusing symlink escapes', async () => {
  const fixture = await createFixture();
  try {
    const catalog = await fetchCatalog(fixture.server.url, fixture.project);
    assert.deepEqual(catalog.skills.map((skill) => [skill.name, skill.source]), [
      ['Review code', 'project'],
      ['Write a brief', 'user'],
    ]);
    assert.equal(JSON.stringify(catalog).includes('do-not-read'), false);

    const selected = catalog.skills[0]!;
    const previewResponse = await fetch(
      `${fixture.server.url}/desktop/skills/${selected.id}?workspace=${encodeURIComponent(fixture.project)}`,
    );
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as { skill: SkillDetail };
    assert.match(preview.skill.content, /Inspect the diff/);
    assert.equal(preview.skill.sourcePath.endsWith(join('review-code', 'SKILL.md')), true);
  } finally {
    await fixture.cleanup();
  }
});

test('persists project and thread selections and resolves them as guarded instructions', async () => {
  const fixture = await createFixture();
  try {
    const initial = await fetchCatalog(fixture.server.url, fixture.project);
    const selected = initial.skills.find((skill) => skill.name === 'Write a brief')!;
    const projectUpdate = await fetch(`${fixture.server.url}/desktop/skills/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: fixture.project,
        scope: 'project',
        enabledSkillIds: [selected.id],
      }),
    });
    assert.equal(projectUpdate.status, 200);

    const inherited = await fetchCatalog(fixture.server.url, fixture.project, 'thread-inheriting');
    assert.deepEqual(inherited.enabledSkillIds, [selected.id]);
    assert.equal(inherited.inherited, true);

    const threadUpdate = await fetch(`${fixture.server.url}/desktop/skills/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: fixture.project,
        threadId: 'thread-disabled',
        scope: 'thread',
        enabledSkillIds: [],
      }),
    });
    assert.equal(threadUpdate.status, 200);
    const disabled = await fixture.runtime.resolveInstructions({
      workspace: fixture.project,
      threadId: 'thread-disabled',
    });
    assert.equal(disabled.systemPrompt, '');

    const restoredRuntime = createSkillsRuntime({
      userSkillDirectories: [fixture.userSkills],
      configPath: join(fixture.base, 'config', 'skills.json'),
    });
    const resolved = await restoredRuntime.resolveInstructions({
      workspace: fixture.project,
      threadId: 'thread-inheriting',
    });
    assert.deepEqual(resolved.enabledSkills.map((skill) => skill.id), [selected.id]);
    assert.match(resolved.systemPrompt, /The local skills selected for this session/);
    assert.match(resolved.systemPrompt, /not authorization to execute anything/);
    assert.match(resolved.systemPrompt, /Example command: `rm -rf \/`/);
  } finally {
    await fixture.cleanup();
  }
});

/**
 * A workspace that has never saved a selection still gets the learning skills,
 * and saving any selection — including an empty one — takes that default away.
 */
test('enables the default skills until a workspace saves its own selection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tawx-skill-defaults-'));
  try {
    const userSkills = join(base, 'user-skills');
    for (const name of ['learn-anything', 'probe-knowledge', 'write-a-brief']) {
      await mkdir(join(userSkills, name), { recursive: true });
      await writeFile(
        join(userSkills, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name} description.\n---\n\nBody of ${name}.`,
      );
    }
    const configPath = join(base, 'config', 'skills.json');
    const runtime = createSkillsRuntime({ userSkillDirectories: [userSkills], configPath });
    const server = await startTestServer(async (request, response) => {
      const handled = await runtime.handleRequest(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'));
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });

    try {
      const workspace = join(base, 'project');
      await mkdir(workspace, { recursive: true });

      const unconfigured = await fetchCatalog(server.url, workspace);
      assert.deepEqual(
        unconfigured.enabledSkillIds.map((id) => unconfigured.skills.find((skill) => skill.id === id)!.name).sort(),
        ['learn-anything', 'probe-knowledge'],
      );

      const defaults = await runtime.resolveInstructions({ workspace });
      assert.deepEqual(defaults.enabledSkills.map((skill) => skill.name).sort(), ['learn-anything', 'probe-knowledge']);
      assert.match(defaults.systemPrompt, /Body of learn-anything/);

      // Chat has no workspace at all and still gets them, over HTTP.
      const instructions = await fetch(`${server.url}/desktop/skills/instructions`);
      assert.equal(instructions.status, 200);
      const payload = await instructions.json() as { systemPrompt: string; enabledSkills: Array<{ name: string }> };
      assert.deepEqual(payload.enabledSkills.map((skill) => skill.name).sort(), ['learn-anything', 'probe-knowledge']);
      assert.match(payload.systemPrompt, /Body of probe-knowledge/);

      const chosen = unconfigured.skills.find((skill) => skill.name === 'write-a-brief')!;
      const update = await fetch(`${server.url}/desktop/skills/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, scope: 'project', enabledSkillIds: [chosen.id] }),
      });
      assert.equal(update.status, 200);
      const configured = await runtime.resolveInstructions({ workspace });
      assert.deepEqual(configured.enabledSkills.map((skill) => skill.name), ['write-a-brief']);

      const cleared = await fetch(`${server.url}/desktop/skills/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, scope: 'project', enabledSkillIds: [] }),
      });
      assert.equal(cleared.status, 200);
      assert.equal((await runtime.resolveInstructions({ workspace })).systemPrompt, '');

      // An explicit empty selection on the request still means "no skills".
      assert.equal((await runtime.resolveInstructions({ enabledSkillIds: [] })).systemPrompt, '');
    } finally {
      await server.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a default skill that is not installed is silently absent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tawx-skill-missing-'));
  try {
    const userSkills = join(base, 'user-skills');
    await mkdir(userSkills, { recursive: true });
    const runtime = createSkillsRuntime({
      userSkillDirectories: [userSkills],
      configPath: join(base, 'config', 'skills.json'),
    });
    const resolved = await runtime.resolveInstructions({});
    assert.deepEqual(resolved.enabledSkills, []);
    assert.deepEqual(resolved.unavailableSkillIds, []);
    assert.equal(resolved.systemPrompt, '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
