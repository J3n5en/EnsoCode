import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const ENSO_SMART_COMPACT_CONFIG = {
  requireApproval: false,
  contextGraphEnabled: false,
  agentToolAccess: 'disabled',
  autoTrigger: true,
  autoTriggerStrategy: 'native-hook',
  showStatus: false,
  mode: 'auto',
} as const;

export function resolveSmartCompactExtensionPath(
  resolveId: (id: string) => string = createRequire(import.meta.url).resolve
): string | undefined {
  try {
    return resolveId('pi-smart-compact');
  } catch {
    return undefined;
  }
}

export function mergeSmartCompactSettings(existing: unknown): Record<string, unknown> {
  const root =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const section =
    root.smartCompact && typeof root.smartCompact === 'object' && !Array.isArray(root.smartCompact)
      ? { ...(root.smartCompact as Record<string, unknown>) }
      : {};
  return {
    ...root,
    smartCompact: { ...section, ...ENSO_SMART_COMPACT_CONFIG },
  };
}

export function smartCompactHostSettingsFile(
  home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir()
): string {
  return path.join(home, '.pi', 'agent', 'settings.json');
}

/** 只改 HOME 下 Pi 的 smartCompact 段；失败由调用方吞掉。 */
export function persistEnsoSmartCompactSettings(file = smartCompactHostSettingsFile()): void {
  let existing: unknown = null;
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    existing = null;
  }
  const next = `${JSON.stringify(mergeSmartCompactSettings(existing), null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
}
