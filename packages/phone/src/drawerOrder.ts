/**
 * 抽屉排序纯函数，与桌面侧栏同语义（src/renderer/stores/sessions/pinned.ts）：
 * 各栏目按活跃时间倒序；置顶手动顺序来自桌面下发的 pinnedOrder。
 */

interface Orderable {
  id: string;
  pinned?: boolean;
  updatedAt?: number;
}

/** 按 updatedAt 倒序（缺失视为 0），时间相同保持原序。不修改入参。 */
export function sortByActivity<T extends Orderable>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 桌面 pinnedConversationIds 同语义：手动顺序命中排前，其余按活跃倒序追加。 */
export function orderPinned<T extends Orderable>(
  sessions: readonly T[],
  manualIds: readonly string[]
): T[] {
  const byActivity = sortByActivity(sessions);
  const remaining = new Map(byActivity.map((session) => [session.id, session]));
  const ordered: T[] = [];
  for (const id of manualIds) {
    const session = remaining.get(id);
    if (session) {
      ordered.push(session);
      remaining.delete(id);
    }
  }
  return [...ordered, ...remaining.values()];
}

/** 桌面 projectConversationIds 同语义：置顶靠前，两组各自按活跃倒序。 */
export function orderProjectSessions<T extends Orderable>(sessions: readonly T[]): T[] {
  return [
    ...sortByActivity(sessions.filter((s) => s.pinned)),
    ...sortByActivity(sessions.filter((s) => !s.pinned)),
  ];
}
