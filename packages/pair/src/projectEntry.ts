import type { ProjectEntry } from './protocol';

export function toPairProjectEntry(project: {
  id: string;
  name: string;
  path: string;
  alias?: string;
  kind?: 'local' | 'ssh';
  sshConnectionName?: string;
  sshHost?: string;
  groupId?: string;
}): ProjectEntry {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    ...(project.alias?.trim() ? { alias: project.alias.trim() } : {}),
    ...(project.groupId ? { groupId: project.groupId } : {}),
    ...(project.kind === 'ssh'
      ? {
          kind: 'ssh' as const,
          ...(project.sshConnectionName ? { sshConnectionName: project.sshConnectionName } : {}),
          ...(project.sshHost ? { sshHost: project.sshHost } : {}),
        }
      : {}),
  };
}

export function sshProjectLabel(
  project: Pick<ProjectEntry, 'kind' | 'sshConnectionName' | 'sshHost'>
): string | undefined {
  if (project.kind !== 'ssh') return undefined;
  const name = project.sshConnectionName?.trim();
  return name || project.sshHost;
}

/**
 * 展示名：别名（去空白非空）优先，否则项目名。
 * 不做桌面那套 name===path 的路径末段回退——项目帧下发前会被 slimProjectsForPhone 删掉 path，
 * 对端根本拿不到可比对的路径。
 */
export function pairProjectDisplayName(project: Pick<ProjectEntry, 'name' | 'alias'>): string {
  return project.alias?.trim() || project.name;
}

export function pairProjectListLabel(project: ProjectEntry): string {
  const name = pairProjectDisplayName(project);
  const badge = sshProjectLabel(project);
  return badge ? `${name} (${badge})` : name;
}
