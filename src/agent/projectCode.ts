import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  COMMAND_SETTINGS,
  listProjectCodeSources,
  parseObject,
  projectSettingsPath,
  readText,
} from './projectCodeSources';

/** 去掉项目 settings 里的代码来源，并排除 .pi/extensions 自动发现；技能、提示词等内容保留 */
function sanitizeProjectSettings(text: string | undefined): string {
  const { packages: _packages, ...rest } = parseObject(text) ?? {};
  for (const key of COMMAND_SETTINGS) delete rest[key];
  return JSON.stringify({ ...rest, extensions: ['!**'] });
}

/**
 * 给 DefaultResourceLoader 用的 SettingsManager：项目代码来源须全部在 trusted 里才按 pi 默认加载，
 * 否则整个项目的扩展与包都不加载（pi 默认信任项目，打开仓库即执行其扩展、自动安装其包）。
 */
export function createProjectSettingsManager(
  cwd: string,
  agentDir: string,
  trusted: readonly string[]
): { settingsManager: SettingsManager; blocked: string[] } {
  const sources = listProjectCodeSources(cwd);
  const blocked = sources.filter((source) => !trusted.includes(source));
  if (sources.length > 0 && blocked.length === 0) {
    return { settingsManager: SettingsManager.create(cwd, agentDir), blocked };
  }
  const paths = { global: join(agentDir, 'settings.json'), project: projectSettingsPath(cwd) };
  const settingsManager = SettingsManager.fromStorage({
    // 只读：loader 不写 settings，拒绝写入避免改动用户文件
    withLock(scope, fn) {
      const current = readText(paths[scope]);
      fn(scope === 'project' ? sanitizeProjectSettings(current) : current);
    },
  });
  return { settingsManager, blocked };
}
