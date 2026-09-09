/**
 * The selected project folder and the containment rules around it.
 *
 * Every filesystem tool resolves through here. Tools are restricted to the
 * folder the user picked in the sidebar, so the check has to survive symlinks
 * and `..` segments — hence realpath on both sides rather than string
 * prefixing, which `/tmp/projectevil` would defeat against `/tmp/project`.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class Workspace {
  private root: string | null = null;
  /** Cached realpath of root, so each tool call does not re-resolve it. */
  private realRoot: string | null = null;

  async select(path: string): Promise<string> {
    const resolved = resolve(path);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      throw new WorkspaceError(`project folder does not exist: ${path}`);
    }
    this.root = resolved;
    this.realRoot = real;
    return real;
  }

  clear(): void {
    this.root = null;
    this.realRoot = null;
  }

  get selected(): string | null {
    return this.root;
  }

  /**
   * Resolves a tool-supplied path inside the project and rejects anything that
   * escapes it. A path that does not exist yet (a file about to be written) is
   * checked against its nearest existing ancestor.
   */
  async resolveInside(candidate: string): Promise<string> {
    if (!this.realRoot) throw new WorkspaceError('no project folder selected');

    const target = isAbsolute(candidate) ? candidate : resolve(this.realRoot, candidate);
    const real = await realpathOfNearestExisting(target);

    if (!contains(this.realRoot, real)) {
      throw new WorkspaceError(`path escapes the selected project folder: ${candidate}`);
    }
    return target;
  }
}

/** True when child is root itself or sits underneath it. */
function contains(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

/**
 * realpath fails on a path that does not exist yet, so walk up to the closest
 * ancestor that does and re-attach the remainder. Without this, writing a new
 * file inside the project would be refused for not existing.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = target;
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = await realpath(current);
      return trailing.length ? resolve(real, ...trailing.reverse()) : real;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return target; // reached the filesystem root
      trailing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
