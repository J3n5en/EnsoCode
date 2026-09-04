export interface UsageProjectRef {
  id: string;
  name: string;
  path: string;
}

export interface UsageWorktreeRef {
  path: string;
  projectId: string;
  repoPath: string;
}

export interface UsageProjectAliases {
  byCwd: Map<string, string>;
  byLeaf: Map<string, string>;
  byProjectId: Map<string, string>;
}

function norm(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function leaf(value: string): string {
  const parts = norm(value).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function projectLabel(project: UsageProjectRef): string {
  return project.name || leaf(project.path);
}

export function buildUsageProjectAliases(
  input: { projects?: readonly UsageProjectRef[]; worktrees?: readonly UsageWorktreeRef[] } = {}
): UsageProjectAliases {
  const byCwd = new Map<string, string>();
  const byLeaf = new Map<string, string>();
  const byProjectId = new Map<string, string>();
  const projects = input.projects ?? [];
  const byId = new Map(projects.map((project) => [project.id, project]));

  for (const project of projects) {
    const label = projectLabel(project);
    if (project.id) byProjectId.set(project.id, label);
    if (project.path) {
      byCwd.set(norm(project.path), label);
      const name = leaf(project.path);
      if (name) byLeaf.set(name, label);
    }
  }

  for (const worktree of input.worktrees ?? []) {
    const project = byId.get(worktree.projectId);
    const label = project ? projectLabel(project) : leaf(worktree.repoPath);
    if (worktree.projectId && label && !byProjectId.has(worktree.projectId)) {
      byProjectId.set(worktree.projectId, label);
    }
    if (worktree.path) {
      byCwd.set(norm(worktree.path), label);
      const name = leaf(worktree.path);
      if (name) byLeaf.set(name, label);
    }
  }

  return { byCwd, byLeaf, byProjectId };
}

function labelFromWorktreesSegment(cwd: string, aliases: UsageProjectAliases): string | undefined {
  const parts = norm(cwd).split('/').filter(Boolean);
  const index = parts.lastIndexOf('worktrees');
  if (index < 0) return undefined;
  const projectId = parts[index + 1];
  const shortId = parts[index + 2];
  if (!projectId || !shortId) return undefined;
  return aliases.byProjectId.get(projectId);
}

export function usageProjectLabel(
  basename: string,
  cwd?: string,
  aliases?: UsageProjectAliases
): string {
  if (aliases && cwd) {
    const exact = aliases.byCwd.get(norm(cwd));
    if (exact) return exact;
    const fromPath = labelFromWorktreesSegment(cwd, aliases);
    if (fromPath) return fromPath;
  }
  if (aliases) {
    const fromLeaf = aliases.byLeaf.get(basename);
    if (fromLeaf) return fromLeaf;
  }
  return basename;
}

export function applyUsageProjectAliases<
  T extends { project: string; cwd?: string; records: { project: string }[] },
>(session: T, aliases?: UsageProjectAliases): T {
  if (!aliases) return session;
  const project = usageProjectLabel(session.project, session.cwd, aliases);
  if (
    project === session.project &&
    session.records.every((record) => record.project === project)
  ) {
    return session;
  }
  return {
    ...session,
    project,
    records: session.records.map((record) =>
      record.project === project ? record : { ...record, project }
    ),
  };
}
