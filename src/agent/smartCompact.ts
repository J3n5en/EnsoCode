import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SpawnModelConfig } from '@shared/types/agent';

export const ENSO_SMART_COMPACT_CONFIG = {
  requireApproval: false,
  contextGraphEnabled: false,
  agentToolAccess: 'disabled',
  autoTrigger: true,
  autoTriggerStrategy: 'native-hook',
  showStatus: false,
  mode: 'auto',
} as const;

export interface SmartCompactRoute {
  summaryModel: string | null;
}

/** provider 注册 id：掺 api/baseUrl/apiKey 指纹。不含斜杠，扩展才能按 provider/id 解析。 */
export function providerKeyFor(model: { api: string; baseUrl: string; apiKey: string }): string {
  const keyFp = createHash('sha256').update(model.apiKey).digest('hex').slice(0, 8);
  const host = createHash('sha256')
    .update(`${model.api}\0${model.baseUrl}`)
    .digest('hex')
    .slice(0, 12);
  return `enso-${host}-${keyFp}`;
}

export function formatSmartCompactSummaryModel(model: SpawnModelConfig): string {
  const provider = model.oauthAccountKey ?? providerKeyFor(model);
  return `${provider}/${model.modelId}`;
}

export function resolveSmartCompactExtensionPath(
  resolveId: (id: string) => string = createRequire(import.meta.url).resolve
): string | undefined {
  try {
    return resolveId('pi-smart-compact');
  } catch {
    return undefined;
  }
}

export function mergeSmartCompactSettings(
  existing: unknown,
  route?: SmartCompactRoute
): Record<string, unknown> {
  const root =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const section =
    root.smartCompact && typeof root.smartCompact === 'object' && !Array.isArray(root.smartCompact)
      ? { ...(root.smartCompact as Record<string, unknown>) }
      : {};
  const smartCompact: Record<string, unknown> = { ...section, ...ENSO_SMART_COMPACT_CONFIG };
  if (route) {
    if (route.summaryModel) smartCompact.summaryModel = route.summaryModel;
    else delete smartCompact.summaryModel;
  }
  return { ...root, smartCompact };
}

export function smartCompactHostSettingsFile(
  home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir()
): string {
  return path.join(home, '.pi', 'agent', 'settings.json');
}

/** 只改 HOME 下 Pi 的 smartCompact 段；失败由调用方吞掉。 */
export function persistEnsoSmartCompactSettings(
  file = smartCompactHostSettingsFile(),
  route?: SmartCompactRoute
): void {
  let existing: unknown = null;
  try {
    existing = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    existing = null;
  }
  const next = `${JSON.stringify(mergeSmartCompactSettings(existing, route), null, 2)}\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
}
