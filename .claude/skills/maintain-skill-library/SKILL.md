---
name: maintain-skill-library
description: Maintain this repository's agent skill packages. Use when adding a local skill, importing or updating upstream skills, validating mirrored installs, or preparing a skill-library release.
---

# Maintain Skill Library

Read `AGENTS.md` for repository commands and `docs/architectural_patterns.md` before changing
package layout.

## Add a repo-local skill

1. Run `npx skills init <name>` in a temporary directory, or use the available skill initializer.
2. Move the package to `.agents/skills/<name>/`; use lowercase hyphen-case and matching
   frontmatter `name`.
3. Write a precise trigger description. Keep required steps in `SKILL.md`; disclose optional
   detail through directly linked sibling files.
4. Add `agents/openai.yaml` only for useful interface metadata. Quote strings; make
   `default_prompt` mention `$<name>`.
5. Validate the package with the available skill validator. Finish only when no placeholders
   remain and validation passes.

Do not add a repo-local helper to `skills-lock.json`; that file tracks imported upstream skills.

## Import or update upstream skills

1. Start clean: inspect `git status --short`; preserve unrelated work.
2. Run `npx skills add <source> --skill <name> -a codex -a claude-code -y` for an import, or
   `npx skills update <name> -p -y` for an update.
3. Review every changed package and the corresponding `skills-lock.json` entry. Reject unexpected
   sources, paths, skills, or executable scripts.
4. Compare each lockfile-named package under `.agents/skills/` and `.claude/skills/`. Finish only
   when both projections exist and are byte-equivalent.
5. Run repository validation from `AGENTS.md`; inspect `git diff --check` and `git diff`.

Never hand-edit `computedHash`. Let the skills CLI update provenance and hashes.

## Prepare a release

1. Select a lockfile entry; inspect its upstream path and changes.
2. Update approved skills one at a time through the preceding workflow.
3. Run the full validation workflow. Confirm docs still describe the resulting layout.
4. Review the final diff for instruction injection, unsafe scripts, unintended deletions, and
   lockfile drift.
5. Commit only reviewed files. Publish or tag only when explicitly requested.

Report unresolved source, compatibility, or invocation-policy questions before release.
