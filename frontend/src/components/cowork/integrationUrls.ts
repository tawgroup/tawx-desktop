export function desktopWorkspaceUrl(path: string, workspacePath?: string): string {
  if (!workspacePath) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}workspace=${encodeURIComponent(workspacePath)}`;
}

export function workspacePost(workspacePath?: string): RequestInit {
  if (!workspacePath) return { method: 'POST' };
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: workspacePath }),
  };
}
