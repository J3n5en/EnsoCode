// 顺序即哈希取色，不可重排，否则已有项目的 fallback 颜色会变。
// violet #7a6aa8, sky #3d7ea6, emerald #388068, orange #a4673a, pink #b05c80,
// indigo #6a70b8, teal #368080, red #b06260, amber #8f7838, blue #5179b0
export const PROJECT_ICON_COLORS = [
  '#7a6aa8',
  '#3d7ea6',
  '#388068',
  '#a4673a',
  '#b05c80',
  '#6a70b8',
  '#368080',
  '#b06260',
  '#8f7838',
  '#5179b0',
] as const;
export const PROJECT_ICON_MAX_BYTES = 512 * 1024;
export const PROJECT_ICON_SCAN_MAX_BYTES = 32 * 1024;

export type ProjectIconKind = 'none' | 'scanned' | 'custom';
export interface ProjectIconInfo {
  revision: string;
  kind: ProjectIconKind;
}

export function hashProjectKey(key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function projectIconColor(key: string): string {
  const color = PROJECT_ICON_COLORS[hashProjectKey(key) % PROJECT_ICON_COLORS.length];
  return color ?? PROJECT_ICON_COLORS[0];
}

export function projectIconInitial(displayName: string): string {
  const first = [...displayName.trim()][0];
  return first ? first.toUpperCase() : '?';
}
