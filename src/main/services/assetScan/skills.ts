import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const HOME = os.homedir();

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
  /** 分组展示名：应用名或插件名 */
  groupName: string;
}

export function displayPath(target: string): string {
  const relative = path.relative(HOME, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return target;
}

/** 解析 SKILL.md 头部的 YAML frontmatter */
function readFrontmatter(file: string): Record<string, unknown> | null {
  const raw = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 扫描一个 skills 根目录下的所有 <name>/SKILL.md */
export function readSkillsRoot(root: string, groupName: string): DiscoveredSkill[] {
  if (!fs.existsSync(root)) return [];
  const skills: DiscoveredSkill[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(root, entry.name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const meta = readFrontmatter(skillFile);
    skills.push({
      name: asText(meta?.name) || entry.name,
      description: asText(meta?.description),
      path: skillDir,
      groupName,
    });
  }

  return skills;
}

interface InstalledPlugins {
  plugins?: Record<string, Array<{ installPath?: string }>>;
}

/** Claude Code 插件包内附带的技能：按 installed_plugins.json 记录的安装路径读取 */
export function readPluginSkills(installedPluginsFile: string): DiscoveredSkill[] {
  if (!fs.existsSync(installedPluginsFile)) return [];

  let manifest: InstalledPlugins;
  try {
    manifest = JSON.parse(fs.readFileSync(installedPluginsFile, 'utf8')) as InstalledPlugins;
  } catch {
    return [];
  }

  const skills: DiscoveredSkill[] = [];
  for (const [pluginKey, installs] of Object.entries(manifest.plugins ?? {})) {
    // "name@marketplace" 只取插件名部分作为分组名
    const pluginName = pluginKey.split('@')[0] || pluginKey;
    for (const install of installs ?? []) {
      if (!install.installPath) continue;
      skills.push(...readSkillsRoot(path.join(install.installPath, 'skills'), pluginName));
    }
  }
  return skills;
}
