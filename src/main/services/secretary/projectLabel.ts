import { projectDisplayName, projectNameFromPath } from '@shared/projectName';
import { redactSecrets } from '../memory/distill';

/** 从 settings.json 的 enso-settings 项目列表取 projectId → 非空别名 */
export function projectAliasesFromSettings(settings: unknown): Record<string, string> {
  const aliases: Record<string, string> = {};
  const state = (settings as { 'enso-settings'?: { state?: { projects?: unknown } } } | null)?.[
    'enso-settings'
  ]?.state;
  if (!Array.isArray(state?.projects)) return aliases;
  for (const raw of state.projects) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, alias } = raw as Record<string, unknown>;
    if (typeof id === 'string' && id && typeof alias === 'string' && alias.trim())
      aliases[id] = alias.trim();
  }
  return aliases;
}

/** 展示名按「别名 > 目录名」取；有别名时额外带上 alias 与 directoryName，方便对上用户叫法 */
export function secretaryProjectNames(
  project: { projectId: string; canonicalPath: string },
  aliases: Readonly<Record<string, string>>
): { name: string; alias?: string; directoryName?: string } {
  const alias = aliases[project.projectId]?.trim();
  const directoryName = projectNameFromPath(project.canonicalPath);
  const name = projectDisplayName({
    name: directoryName,
    path: project.canonicalPath,
    alias,
  });
  return alias
    ? {
        name: redactSecrets(name),
        alias: redactSecrets(alias),
        directoryName: redactSecrets(directoryName),
      }
    : { name: redactSecrets(name) };
}

/** 秘书对用户称呼项目时用的名字：有别名用别名，否则目录名 */
export function secretaryProjectName(
  project: { projectId: string; canonicalPath: string } | undefined,
  aliases: Readonly<Record<string, string>> = {}
): string {
  if (!project) return '';
  return secretaryProjectNames(project, aliases).name;
}
