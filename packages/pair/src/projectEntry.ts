import type { ProjectEntry } from './protocol';

export function toPairProjectEntry(project: {
  id: string;
  name: string;
  path: string;
  kind?: 'local' | 'ssh';
  sshConnectionName?: string;
  sshHost?: string;
}): ProjectEntry {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
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

export function pairProjectListLabel(project: ProjectEntry): string {
  const badge = sshProjectLabel(project);
  return badge ? `${project.name} (${badge})` : project.name;
}
