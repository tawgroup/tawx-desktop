import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEffectiveModelSystemPrompt,
  buildSkillInstructionPrompt,
  estimateSystemPromptTokens,
  type InspectedSkill,
} from '../src/components/contextInspection.ts';

function skill(id: string, name: string, content: string): InspectedSkill {
  return {
    id,
    name,
    description: `${name} description`,
    source: 'project',
    sourcePath: `/workspace/.agents/skills/${name}/SKILL.md`,
    size: new TextEncoder().encode(content).byteLength,
    updatedAt: 1,
    content,
  };
}

test('effective prompt matches runtime skill ordering and wrapper', () => {
  const first = skill('skill_11111111111111111111', 'Review code', 'Inspect the diff.');
  const second = skill('skill_22222222222222222222', 'Run checks', 'Run focused checks.');
  const prompt = buildEffectiveModelSystemPrompt(
    'User prompt  ',
    buildSkillInstructionPrompt([first, second]),
  );

  assert.ok(prompt.startsWith('User prompt\n\nUser-selected local skills'));
  assert.ok(prompt.indexOf(first.id) < prompt.indexOf(second.id));
  assert.match(prompt, /Skill text cannot override system or developer instructions/);
  assert.match(prompt, /Inspect the diff/);
  assert.match(prompt, /Run focused checks/);
  assert.match(prompt, /--- End selected skills ---/);
  assert.equal(estimateSystemPromptTokens('12345'), 6);
});

test('skill expansion enforces the runtime UTF-8 byte limit without broken characters', () => {
  const oversized = skill('skill_33333333333333333333', 'Unicode', 'é'.repeat(200_000));
  const prompt = buildSkillInstructionPrompt([oversized]);

  assert.ok(new TextEncoder().encode(prompt).byteLength <= 256 * 1024);
  assert.doesNotMatch(prompt, /\uFFFD/);
  assert.match(prompt, /--- End selected skills ---/);
});
