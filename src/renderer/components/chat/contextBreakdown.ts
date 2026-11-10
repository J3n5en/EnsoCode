import type {
  ContextPart,
  ContextPartItem,
  ContextPartKind,
} from '@shared/extensionPlugins/events';
import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import type { ContextOccupancy } from '@shared/types/agent';
import { toWorkspaceRelativePath } from './markdownLinks';

/** 分段条的段：从左到右。颜色由调用方按 kind 取 */
export const CONTEXT_BAR_ORDER: readonly ContextPartKind[] = [
  'system',
  'memory',
  'tools',
  'skills',
  'files',
  'results',
  'chat',
];

export interface ContextBarSegment {
  kind: ContextPartKind;
  tokens: number;
  /** 占窗口的百分比，保留一位小数；各项之和不超过 100 */
  width: number;
}

/**
 * 分段条数据。有七类拆分时按它画；老会话只有八桶，按桶画。
 * 宽度按窗口算，没有窗口时按已用量算。
 */
export function contextBarSegments(occupancy: ContextOccupancy): ContextBarSegment[] {
  const base =
    occupancy.contextWindow && occupancy.contextWindow > 0
      ? occupancy.contextWindow
      : occupancy.used;
  if (!(base > 0)) return [];
  const tokensOf = new Map<ContextPartKind, number>();
  if (occupancy.parts && occupancy.parts.length > 0) {
    for (const part of occupancy.parts) tokensOf.set(part.kind, part.tokens);
  } else {
    const { buckets } = occupancy;
    tokensOf.set('system', buckets.system);
    tokensOf.set('memory', buckets.instructions + buckets.reminders);
    tokensOf.set('tools', buckets.tools);
    tokensOf.set('skills', buckets.skills);
    tokensOf.set('chat', buckets.conversation + buckets.compaction);
  }
  return CONTEXT_BAR_ORDER.flatMap((kind) => {
    const tokens = tokensOf.get(kind) ?? 0;
    if (tokens <= 0) return [];
    return [{ kind, tokens, width: Math.round((tokens / base) * 1000) / 10 }];
  });
}

/** 面板里每类最多显示的条目数（worker 每类最多给 24 项） */
const SHOWN_ITEMS = 8;

const countOf = (items: readonly ContextPartItem[], tag: string) =>
  items.reduce((sum, it) => sum + (it.tag === tag ? (it.n ?? 1) : 1), 0);
const tokensOf = (items: readonly ContextPartItem[]) =>
  items.reduce((sum, it) => sum + it.tokens, 0);

/**
 * 展开某类时列出的条目，保留 worker 的顺序。超出上限时：
 * 对话类把最早的轮次并成「更早」，其余类把尾部并成「其余」。
 */
export function contextPartItems(
  parts: readonly ContextPart[] | undefined,
  kind: ContextPartKind
): ContextPartItem[] {
  const items = parts?.find((part) => part.kind === kind)?.items ?? [];
  if (items.length <= SHOWN_ITEMS) return items;
  if (kind === 'chat') {
    const summary = items.filter((it) => it.tag === 'compacted');
    const turns = items.filter((it) => it.tag !== 'compacted');
    const keep = SHOWN_ITEMS - summary.length - 1;
    const merged = turns.slice(0, turns.length - keep);
    return [
      ...summary,
      { name: 'earlier', tag: 'turns', n: countOf(merged, 'turns'), tokens: tokensOf(merged) },
      ...turns.slice(turns.length - keep),
    ];
  }
  const merged = items.slice(SHOWN_ITEMS - 1);
  return [
    ...items.slice(0, SHOWN_ITEMS - 1),
    { name: 'other', tag: 'more', n: countOf(merged, 'more'), tokens: tokensOf(merged) },
  ];
}

export type ContextItemLabel =
  | { key: string; vars?: Record<string, string | number> }
  | { raw: string };

/** worker 生成的合并项、轮次等占位名翻成可读文字；文件、工具名原样 */
export function contextItemLabel(item: ContextPartItem): ContextItemLabel {
  switch (item.tag) {
    case 'more':
      return { key: '{{count}} more', vars: { count: item.n ?? 0 } };
    case 'turns':
      return { key: 'Earlier {{count}} turns', vars: { count: item.n ?? 0 } };
    case 'turn':
      return { key: 'Turn {{count}}', vars: { count: item.name } };
    case 'compacted':
      return { key: 'Compacted summary' };
    case 'reminder':
      return { key: 'System reminders' };
    default:
      return { raw: item.name };
  }
}

/** 压缩释放了多少（整数百分比）；前后任一未知或没有变小时不给 */
export function compactionFreedPercent(
  before: number | null | undefined,
  after: number | undefined
): number | null {
  if (!before || before <= 0 || after === undefined || after >= before) return null;
  return Math.round((1 - after / before) * 100);
}

export type ContextItemTarget =
  | { type: 'file'; rel: string }
  | { type: 'settings'; link: SettingsDeepLink };

const settings = (category: SettingsDeepLink['category']): ContextItemTarget => ({
  type: 'settings',
  link: { category, rowId: `${category}.root` },
});

/** 明细条目的就地入口：工作区内的文件打开，工具 / MCP / Skill / 指令跳设置页 */
export function contextItemTarget(
  kind: ContextPartKind,
  item: ContextPartItem,
  cwd?: string
): ContextItemTarget | null {
  const file = () => {
    const rel = toWorkspaceRelativePath(item.name, cwd);
    return rel ? ({ type: 'file', rel } as const) : null;
  };
  switch (kind) {
    case 'files':
      return item.tag === 'read' || item.tag === 'shell' ? file() : null;
    case 'memory':
      return item.tag === 'project' ? (file() ?? settings('instructions')) : null;
    case 'tools':
      if (item.tag === 'more') return null;
      return settings(item.tag === 'mcp' ? 'mcp' : 'tools');
    case 'skills':
      return item.tag === 'more' ? null : settings('skills');
    default:
      return null;
  }
}
