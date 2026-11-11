/** 输入框底栏的插件状态项：清单声明打底，main.mjs 经 enso.ui.status.update 运行期改 */

export const STATUS_TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];
export const MAX_STATUS_TEXT = 24;
export const MAX_STATUS_TOOLTIP = 200;
export const MAX_STATUS_ITEMS = 8;

export interface PluginStatusItemContrib {
  id: string;
  text: string;
  tooltip?: string;
  /** 点击时执行的本插件命令 id */
  command?: string;
}

export interface StatusPatch {
  text?: string;
  tooltip?: string;
  tone?: StatusTone;
  visible?: boolean;
}

export interface PluginStatusItem {
  id: string;
  text: string;
  tooltip?: string;
  tone: StatusTone;
  visible: boolean;
  command?: string;
}

const PATCH_KEYS = new Set(['text', 'tooltip', 'tone', 'visible']);

/** 校验运行期补丁；坏字段整体拒绝，过长文本截断 */
export function parseStatusPatch(raw: unknown): StatusPatch | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PATCH_KEYS.has(key))) return null;
  const patch: StatusPatch = {};
  if (record.text !== undefined) {
    if (typeof record.text !== 'string') return null;
    patch.text = record.text.slice(0, MAX_STATUS_TEXT);
  }
  if (record.tooltip !== undefined) {
    if (typeof record.tooltip !== 'string') return null;
    patch.tooltip = record.tooltip.slice(0, MAX_STATUS_TOOLTIP);
  }
  if (record.tone !== undefined) {
    if (!(STATUS_TONES as readonly unknown[]).includes(record.tone)) return null;
    patch.tone = record.tone as StatusTone;
  }
  if (record.visible !== undefined) {
    if (typeof record.visible !== 'boolean') return null;
    patch.visible = record.visible;
  }
  return patch;
}

export function mergeStatusItems(
  declared: readonly PluginStatusItemContrib[],
  state: Readonly<Record<string, StatusPatch>>
): PluginStatusItem[] {
  return declared.map((item) => {
    const patch = Object.hasOwn(state, item.id) ? state[item.id] : undefined;
    const tooltip = patch?.tooltip ?? item.tooltip;
    return {
      id: item.id,
      text: patch?.text ?? item.text,
      ...(tooltip !== undefined ? { tooltip } : {}),
      tone: patch?.tone ?? 'neutral',
      visible: patch?.visible ?? true,
      ...(item.command !== undefined ? { command: item.command } : {}),
    };
  });
}
