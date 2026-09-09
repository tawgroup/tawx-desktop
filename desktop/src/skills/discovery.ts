import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type SkillSource = 'project' | 'user';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourcePath: string;
  size: number;
  updatedAt: number;
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface SkillDiscoveryOptions {
  userSkillDirectories?: readonly string[];
  maxSkillBytes?: number;
}

const DEFAULT_MAX_SKILL_BYTES = 128 * 1024;
const REPOSITORY_SKILL_DIRECTORIES = ['.claude/skills', '.agents/skills'] as const;

export async function discoverSkills(
  workspace: string | undefined,
  options: SkillDiscoveryOptions = {},
): Promise<SkillDetail[]> {
  const roots: Array<{ path: string; source: SkillSource; workspaceRoot?: string }> = [];
  const canonicalWorkspace = workspace ? await canonicalDirectory(workspace) : undefined;

  if (canonicalWorkspace) {
    for (const directory of REPOSITORY_SKILL_DIRECTORIES) {
      roots.push({ path: join(canonicalWorkspace, directory), source: 'project', workspaceRoot: canonicalWorkspace });
    }
  }

  const userDirectories = options.userSkillDirectories ?? defaultUserSkillDirectories();
  for (const directory of userDirectories) roots.push({ path: resolve(directory), source: 'user' });

  const seenRoots = new Set<string>();
  const skills: SkillDetail[] = [];
  for (const root of roots) {
    const canonicalRoot = await safeRoot(root.path, root.workspaceRoot);
    if (!canonicalRoot || seenRoots.has(canonicalRoot)) continue;
    seenRoots.add(canonicalRoot);
    try {
      skills.push(...await readRoot(canonicalRoot, root.source, options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES));
    } catch (error) {
      if (!isMissing(error) && !isUnsafeLink(error) && !isPermissionDenied(error)) throw error;
    }
  }

  return skills.sort((left, right) => {
    if (left.source !== right.source) return left.source === 'project' ? -1 : 1;
    const byName = left.name.toLocaleLowerCase('en').localeCompare(right.name.toLocaleLowerCase('en'), 'en');
    return byName || left.sourcePath.localeCompare(right.sourcePath, 'en');
  });
}

function defaultUserSkillDirectories(): string[] {
  const home = homedir();
  const desktopHome = process.env.TAWX_DESKTOP_HOME ?? join(home, 'tawx-desktop');
  return [
    join(desktopHome, 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.config', 'tawx', 'skills'),
  ];
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`workspace is not a directory: ${path}`);
  return canonical;
}

async function safeRoot(path: string, workspaceRoot?: string): Promise<string | undefined> {
  try {
    const initial = await lstat(path);
    if (!initial.isDirectory() || initial.isSymbolicLink()) return undefined;
    const canonical = await realpath(path);
    if (workspaceRoot && !isInside(workspaceRoot, canonical)) return undefined;
    return canonical;
  } catch (error) {
    if (isMissing(error) || isUnsafeLink(error) || isPermissionDenied(error)) return undefined;
    throw error;
  }
}

async function readRoot(root: string, source: SkillSource, maxBytes: number): Promise<SkillDetail[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const skills: SkillDetail[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const skillDirectory = join(root, entry.name);
    const skillPath = join(skillDirectory, 'SKILL.md');
    const skill = await readSkill(skillPath, entry.name, source, maxBytes);
    if (skill) skills.push(skill);
  }

  return skills;
}

async function readSkill(
  skillPath: string,
  directoryName: string,
  source: SkillSource,
  maxBytes: number,
): Promise<SkillDetail | undefined> {
  let handle;
  try {
    const directoryInfo = await lstat(resolve(skillPath, '..'));
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return undefined;

    const pathInfo = await lstat(skillPath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1 || pathInfo.size > maxBytes) {
      return undefined;
    }

    handle = await open(skillPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile() || fileInfo.nlink !== 1 || fileInfo.size > maxBytes) return undefined;

    const raw = await handle.readFile({ encoding: 'utf8' });
    if (raw.includes('\0')) return undefined;
    const safeText = raw.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const parsed = parseSkill(safeText, directoryName);
    const absolutePath = resolve(skillPath);
    return {
      id: `skill_${createHash('sha256').update(absolutePath).digest('hex').slice(0, 20)}`,
      name: parsed.name,
      description: parsed.description,
      source,
      sourcePath: absolutePath,
      size: fileInfo.size,
      updatedAt: fileInfo.mtimeMs,
      content: parsed.content,
    };
  } catch (error) {
    if (isMissing(error) || isUnsafeLink(error) || isPermissionDenied(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseSkill(raw: string, directoryName: string): { name: string; description: string; content: string } {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let bodyStart = 0;
  const metadata = new Map<string, string>();

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
        if (match?.[1] && match[2] !== undefined) metadata.set(match[1].toLowerCase(), unquote(match[2]));
      }
      bodyStart = end + 1;
    }
  }

  const content = lines.slice(bodyStart).join('\n').trim();
  const metadataName = cleanMetadata(metadata.get('name'), 120);
  const headingName = cleanMetadata(/^#\s+(.+)$/m.exec(content)?.[1], 120);
  const name = metadataName || headingName || humanize(directoryName);
  const metadataDescription = cleanMetadata(metadata.get('description'), 500);
  const firstParagraph = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim())
    .find(Boolean);
  const description = metadataDescription || cleanMetadata(firstParagraph, 500) || 'Local skill instructions';
  return { name, description, content };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function cleanMetadata(value: string | undefined, maxLength: number): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function humanize(directoryName: string): string {
  const value = basename(directoryName).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return value ? value.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase()) : 'Unnamed skill';
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isUnsafeLink(error: unknown): boolean {
  return ['ELOOP', 'EMLINK'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

function isPermissionDenied(error: unknown): boolean {
  return ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}
