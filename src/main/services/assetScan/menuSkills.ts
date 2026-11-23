// 斜杠菜单的 skill 列表：走 pi 的发现规则，依赖 pi-coding-agent，由 IPC 处理时按需加载
import { DefaultPackageManager, loadSkills } from '@earendil-works/pi-coding-agent';
import { resolveHarnessSkillRoots } from '../../../agent/harnessAssets';
import { createProjectSettingsManager } from '../../../agent/projectCode';

/** 指定 skill 目录里的 skill；坏目录由 loadSkills 记诊断后跳过 */
export function listSkillsAt(
  skillPaths: readonly string[],
  agentDir: string
): { name: string; description: string }[] {
  if (skillPaths.length === 0) return [];
  return loadSkills({
    cwd: agentDir,
    agentDir,
    skillPaths: [...skillPaths],
    includeDefaults: false,
  }).skills.map(({ name, description }) => ({ name, description }));
}

/** spawn 前斜杠菜单用：与 worker 的 DefaultResourceLoader 同一套 pi 发现规则（agentDir、settings、
 * 项目信任一致），未安装的包跳过不装。includeHarness 对应「加载项目内其它工具目录」，追加在 pi 根之后 */
export async function listProjectSkills(
  cwd: string,
  options: { agentDir: string; trustedProjectCode?: readonly string[]; includeHarness?: boolean }
): Promise<{ name: string; description: string }[]> {
  const { agentDir } = options;
  const { settingsManager } = createProjectSettingsManager(
    cwd,
    agentDir,
    options.trustedProjectCode ?? []
  );
  const resolved = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(
    async () => 'skip'
  );
  const skillPaths = [
    ...resolved.skills.filter((entry) => entry.enabled).map((entry) => entry.path),
    ...(options.includeHarness ? resolveHarnessSkillRoots(cwd) : []),
  ];
  return loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false }).skills.map(
    ({ name, description }) => ({ name, description })
  );
}
