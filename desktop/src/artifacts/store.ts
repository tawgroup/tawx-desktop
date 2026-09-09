import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { Workspace } from '../tools/workspace.js';

export const ARTIFACT_DIRECTORY = '.tawx/artifacts';
const MAX_ARTIFACT_BYTES = 5_000_000;
const MAX_TEXT_PREVIEW_BYTES = 50_000;
const MAX_IMAGE_PREVIEW_BYTES = 1_000_000;
const MAX_LISTED_ARTIFACTS = 100;

export interface ArtifactMetadata {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  modifiedAt: string;
}

export interface ArtifactPreview extends ArtifactMetadata {
  preview:
    | { kind: 'text'; content: string; truncated: boolean }
    | { kind: 'image'; content: string; truncated: false }
    | { kind: 'binary'; content: null; truncated: false };
}

export interface CreateArtifactInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

/** Safe, stateless storage under <workspace>/.tawx/artifacts. */
export class ArtifactStore {
  async create(workspaceRoot: string, input: CreateArtifactInput): Promise<ArtifactPreview> {
    const relativePath = validateArtifactPath(input.path);
    const workspace = await selectedWorkspace(workspaceRoot);
    const root = await workspace.resolveInside(ARTIFACT_DIRECTORY);
    const target = await workspace.resolveInside(join(ARTIFACT_DIRECTORY, relativePath));
    const content = decodeContent(input.content, input.encoding ?? 'utf8');
    if (content.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    }

    await mkdir(root, { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    // Re-resolve after creating parents so a pre-existing symlink cannot cross the workspace boundary.
    await workspace.resolveInside(join(ARTIFACT_DIRECTORY, relativePath));
    const temporary = join(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    return this.read(workspaceRoot, encodeArtifactId(relativePath));
  }

  async list(workspaceRoot: string): Promise<ArtifactMetadata[]> {
    const workspace = await selectedWorkspace(workspaceRoot);
    const root = await workspace.resolveInside(ARTIFACT_DIRECTORY);
    try {
      const entries: ArtifactMetadata[] = [];
      await collectArtifacts(workspace, root, root, entries);
      return entries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async read(workspaceRoot: string, id: string): Promise<ArtifactPreview> {
    const relativePath = decodeArtifactId(id);
    const workspace = await selectedWorkspace(workspaceRoot);
    const target = await workspace.resolveInside(join(ARTIFACT_DIRECTORY, relativePath));
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`artifact is not a file: ${relativePath}`);
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
    const content = await readFile(target);
    const mimeType = inferMimeType(relativePath);
    const metadata: ArtifactMetadata = {
      id: encodeArtifactId(relativePath),
      name: basename(relativePath),
      path: relativePath,
      mimeType,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    };

    if (isTextMime(mimeType)) {
      const bounded = content.subarray(0, MAX_TEXT_PREVIEW_BYTES);
      return {
        ...metadata,
        preview: {
          kind: 'text',
          content: bounded.toString('utf8'),
          truncated: content.byteLength > bounded.byteLength,
        },
      };
    }
    if (isPreviewableImage(mimeType) && content.byteLength <= MAX_IMAGE_PREVIEW_BYTES) {
      return {
        ...metadata,
        preview: {
          kind: 'image',
          content: `data:${mimeType};base64,${content.toString('base64')}`,
          truncated: false,
        },
      };
    }
    return { ...metadata, preview: { kind: 'binary', content: null, truncated: false } };
  }
}

async function collectArtifacts(
  workspace: Workspace,
  root: string,
  directory: string,
  output: ArtifactMetadata[],
): Promise<void> {
  if (output.length >= MAX_LISTED_ARTIFACTS) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= MAX_LISTED_ARTIFACTS) return;
    const absolute = await workspace.resolveInside(join(directory, entry.name));
    if (entry.isDirectory()) {
      await collectArtifacts(workspace, root, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolute);
    const artifactPath = relative(root, absolute).split(sep).join('/');
    output.push({
      id: encodeArtifactId(artifactPath),
      name: entry.name,
      path: artifactPath,
      mimeType: inferMimeType(artifactPath),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
}

async function selectedWorkspace(root: string): Promise<Workspace> {
  if (!isAbsolute(root)) throw new Error('Select a project before using artifacts.');
  const workspace = new Workspace();
  await workspace.select(root);
  return workspace;
}

function validateArtifactPath(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('artifact path is required');
  if (value.includes('\0') || isAbsolute(value)) throw new Error('artifact path must be relative to the artifact directory');
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('artifact path contains an invalid segment');
  }
  if (normalized.length > 240) throw new Error('artifact path exceeds 240 characters');
  return normalized;
}

function encodeArtifactId(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url');
}

function decodeArtifactId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('invalid artifact id');
  const path = Buffer.from(id, 'base64url').toString('utf8');
  if (encodeArtifactId(path) !== id) throw new Error('invalid artifact id');
  return validateArtifactPath(path);
}

function decodeContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  if (typeof content !== 'string') throw new Error('artifact content must be a string');
  if (encoding === 'utf8') return Buffer.from(content, 'utf8');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new Error('artifact content is not valid base64');
  }
  return Buffer.from(content, 'base64');
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'text/typescript',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

function inferMimeType(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}


function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/xml'
    || mimeType === 'application/yaml'
    || mimeType === 'image/svg+xml';
}

function isPreviewableImage(mimeType: string): boolean {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/gif' || mimeType === 'image/webp';
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
