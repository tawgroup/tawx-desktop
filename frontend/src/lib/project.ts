const CONTEXT_FILES = /(^|\/)(readme(?:\.[^/]*)?|package\.json|go\.mod|pyproject\.toml|cargo\.toml)$/i;
const IGNORED = /(^|\/)(\.git|node_modules|dist|build|vendor)(\/|$)/;

export async function readProject(files: File[]) {
  const useful = files.filter((file) => !IGNORED.test(file.webkitRelativePath || file.name));
  const paths = useful.map((file) => file.webkitRelativePath || file.name).sort();
  const name = paths[0]?.split('/')[0] || 'Project';
  const tree = paths.slice(0, 300).join('\n');
  const documents = await Promise.all(
    useful
      .filter((file) => CONTEXT_FILES.test(file.webkitRelativePath || file.name))
      .sort((a, b) => (a.webkitRelativePath || a.name).split('/').length - (b.webkitRelativePath || b.name).split('/').length)
      .slice(0, 6)
      .map(async (file) => `\n--- ${file.webkitRelativePath || file.name} ---\n${(await file.text()).slice(0, 12_000)}`),
  );

  return {
    name,
    fileCount: paths.length,
    hasOverview: documents.length > 0,
    context: `Selected project: ${name}\nSnapshot scope: file tree and the included overview files only. Do not infer the project's purpose from its folder name. If the evidence is insufficient, say so and ask for the code repository root.\n\nFile tree:\n${tree}${paths.length > 300 ? '\n…' : ''}${documents.join('')}`.slice(0, 32_000),
  };
}
