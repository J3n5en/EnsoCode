import { TRANSCRIPT_LABELS } from '../../../shared/bots/transcript';
import type { BotId, GroupEntry } from '../../../shared/types/bot';

export const GROUP_HISTORY_LIMITS = {
  defaultLimit: 30,
  maxLimit: 100,
  entryChars: 2000,
  totalChars: 40_000,
} as const;

export interface GroupHistoryQuery {
  beforeSeq?: number;
  afterSeq?: number;
  limit: number;
  query?: string;
  from?: string;
}

interface HistoryItem {
  seq: number;
  at: string;
  from: string;
  text: string;
  truncated?: true;
}

const HUMAN_ALIASES = new Set([
  TRANSCRIPT_LABELS.human,
  TRANSCRIPT_LABELS.humanRole,
  'user',
  'human',
]);
const SYSTEM_ALIASES = new Set([TRANSCRIPT_LABELS.system, 'system']);

const seqOk = (value: unknown, min: number) =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) >= min);
const textOk = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);

/** Main 侧按 unknown 收窄；返回字符串表示参数错误 */
export function parseGroupHistoryQuery(
  params: Record<string, unknown>
): GroupHistoryQuery | string {
  const { beforeSeq, afterSeq, limit, query, from } = params;
  if (!seqOk(beforeSeq, 1) || !seqOk(afterSeq, 0))
    return 'beforeSeq / afterSeq must be non-negative integers.';
  if (
    limit !== undefined &&
    !(Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100)
  )
    return `limit must be an integer between 1 and ${GROUP_HISTORY_LIMITS.maxLimit}.`;
  if (!textOk(query, 200) || !textOk(from, 64)) return 'query / from must be short strings.';
  return {
    ...(beforeSeq !== undefined ? { beforeSeq: beforeSeq as number } : {}),
    ...(afterSeq !== undefined ? { afterSeq: afterSeq as number } : {}),
    limit: (limit as number | undefined) ?? GROUP_HISTORY_LIMITS.defaultLimit,
    ...(query !== undefined ? { query: query as string } : {}),
    ...(from !== undefined ? { from: from as string } : {}),
  };
}

function describe(entry: GroupEntry, nameOf: (id: BotId) => string | undefined) {
  const name = (id: BotId) => nameOf(id) ?? TRANSCRIPT_LABELS.deleted;
  switch (entry.kind) {
    case 'human':
      return { from: TRANSCRIPT_LABELS.human, text: entry.text };
    case 'bot':
      return { from: name(entry.botId), text: entry.text };
    case 'delegation': {
      const head = TRANSCRIPT_LABELS.delegation(
        name(entry.from),
        name(entry.to),
        TRANSCRIPT_LABELS.delegationState[entry.state] ?? entry.state
      );
      const summary = entry.summary?.replace(/\s+/g, ' ').trim();
      return { from: TRANSCRIPT_LABELS.system, text: summary ? `${head}：${summary}` : head };
    }
    default:
      return { from: TRANSCRIPT_LABELS.system, text: entry.text };
  }
}

function clip(text: string): { text: string; truncated?: true } {
  const max = GROUP_HISTORY_LIMITS.entryChars;
  return text.length <= max
    ? { text }
    : { text: `${text.slice(0, max)}…[truncated, ${text.length} chars total]`, truncated: true };
}

type HistoryResult =
  | { ok: true; entries: HistoryItem[]; hasMore: boolean; lastSeq: number }
  | { ok: false; error: string };

/** 群时间线原文查询：seq 区间 + 发言人 + 关键词过滤；无 afterSeq 时取最近，有 afterSeq 无 beforeSeq 时向后翻 */
export function queryGroupHistory(
  entries: readonly GroupEntry[],
  nameOf: (id: BotId) => string | undefined,
  query: GroupHistoryQuery
): HistoryResult {
  return queryGroupHistoryNewestFirst([...entries].reverse(), nameOf, query);
}

/** 同上，输入为从新到旧的惰性序列：够一页（并多看到一条以判断 hasMore）就停止拉取 */
export function queryGroupHistoryNewestFirst(
  newestFirst: Iterable<GroupEntry>,
  nameOf: (id: BotId) => string | undefined,
  query: GroupHistoryQuery
): HistoryResult {
  let speaker: ((entry: GroupEntry, from: string) => boolean) | undefined;
  let wantedName: string | undefined;
  if (query.from !== undefined) {
    const wanted = query.from.trim().toLowerCase();
    if (HUMAN_ALIASES.has(wanted)) speaker = (entry) => entry.kind === 'human';
    else if (SYSTEM_ALIASES.has(wanted))
      speaker = (entry) => entry.kind === 'system' || entry.kind === 'delegation';
    else {
      wantedName = wanted;
      speaker = (entry, from) => entry.kind === 'bot' && from.toLowerCase() === wanted;
    }
  }
  // 发言人名字 → 最早出现的 seq；名字未确认存在前不提前停止
  const known = new Map<string, number>();
  let resolved = wantedName === undefined;
  const forward = query.afterSeq !== undefined && query.beforeSeq === undefined;
  const needle = query.query?.toLowerCase();
  const matched: { entry: GroupEntry; from: string; text: string }[] = [];
  let lastSeq: number | undefined;
  for (const entry of newestFirst) {
    lastSeq ??= entry.seq;
    if (wantedName !== undefined && entry.kind === 'bot') {
      const name = nameOf(entry.botId) ?? TRANSCRIPT_LABELS.deleted;
      known.set(name, entry.seq);
      if (name.toLowerCase() === wantedName) resolved = true;
    }
    if (query.afterSeq !== undefined && entry.seq <= query.afterSeq) {
      if (resolved) break;
      continue;
    }
    if (query.beforeSeq !== undefined && entry.seq >= query.beforeSeq) continue;
    const { from, text } = describe(entry, nameOf);
    if (speaker && !speaker(entry, from)) continue;
    if (needle && !text.toLowerCase().includes(needle)) continue;
    matched.push({ entry, from, text });
    if (!forward && resolved && matched.length > query.limit) break;
  }
  if (!resolved) {
    const names = [...known].sort((a, b) => a[1] - b[1]).map(([name]) => name);
    return {
      ok: false,
      error: `Unknown speaker "${query.from}". Known: ${[TRANSCRIPT_LABELS.human, ...names].join(', ')}.`,
    };
  }
  // 从翻页方向的近端开始装，超出条数或总字数即停
  const ordered = forward ? matched.reverse() : matched;
  const picked: HistoryItem[] = [];
  let total = 0;
  for (const { entry, from, text } of ordered) {
    if (picked.length >= query.limit) break;
    const clipped = clip(text);
    if (picked.length > 0 && total + clipped.text.length > GROUP_HISTORY_LIMITS.totalChars) break;
    total += clipped.text.length;
    picked.push({ seq: entry.seq, at: new Date(entry.at).toISOString(), from, ...clipped });
  }
  if (!forward) picked.reverse();
  return {
    ok: true,
    entries: picked,
    hasMore: picked.length < matched.length,
    lastSeq: lastSeq ?? 0,
  };
}
