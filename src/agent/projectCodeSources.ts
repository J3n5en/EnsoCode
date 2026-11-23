import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 项目 settings 里能让 pi 执行代码的键（扩展/包由单独规则处理） */
export const COMMAND_SETTINGS = ['npmCommand', 'shellPath', 'shellCommandPrefix'] as const;

export function projectSettingsPath(cwd: string): string {
  return join(cwd, '.pi', 'settings.json');
}

export function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function packageSource(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (
    entry &&
    typeof entry === 'object' &&
    typeof (entry as { source?: unknown }).source === 'string'
  ) {
    return (entry as { source: string }).source;
  }
  return undefined;
}

/** 项目内会被 pi 当作代码加载或执行的来源（.pi/extensions、项目包、扩展路径、命令类设置） */
export function listProjectCodeSources(cwd: string): string[] {
  const sources = new Set<string>();
  const extensionsDir = join(cwd, '.pi', 'extensions');
  if (existsSync(extensionsDir)) {
    try {
      for (const name of readdirSync(extensionsDir)) {
        if (!name.startsWith('.') && name !== 'node_modules') sources.add(`.pi/extensions/${name}`);
      }
    } catch {
      sources.add('.pi/extensions');
    }
  }
  const settings = parseObject(readText(projectSettingsPath(cwd)));
  if (settings) {
    for (const entry of Array.isArray(settings.packages) ? settings.packages : []) {
      const source = packageSource(entry);
      if (source) sources.add(`package:${source}`);
    }
    for (const entry of Array.isArray(settings.extensions) ? settings.extensions : []) {
      if (typeof entry === 'string' && !/^[!+-]/.test(entry)) sources.add(`extension:${entry}`);
    }
    for (const key of COMMAND_SETTINGS) {
      if (settings[key] !== undefined) sources.add(`setting:${key}`);
    }
  }
  return [...sources].sort();
}
