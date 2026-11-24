import { conversationDotTone } from '@shared/conversationDotTone';

/**
 * 抽屉排序纯函数，与桌面侧栏同语义（src/renderer/stores/sessions/pinned.ts）：
 * 各栏目按活跃时间倒序；置顶手动顺序来自桌面下发的 pinnedOrder。
 */

interface Orderable {
  id: string;
  pinned?: boolean;
  updatedAt?: number;
  pendingAskCount?: number;
  pendingApprovalCount?: number;
}

/** 按 updatedAt 倒序（缺失视为 0），时间相同保持原序。不修改入参。 */
export function sortByActivity<T extends Orderable>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** 桌面 waitingFirst 同语义：待提问 / 待审批的稳定置前。 */
function waitingFirst<T extends Orderable>(sessions: T[]): T[] {
  const waiting = (s: T) => (s.pendingAskCount ?? 0) > 0 || (s.pendingApprovalCount ?? 0) > 0;
  return [...sessions.filter(waiting), ...sessions.filter((s) => !waiting(s))];
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
  return [...ordered, ...waitingFirst([...remaining.values()])];
}

/** 桌面 projectConversationIds 同语义：置顶靠前，两组各自按活跃倒序。 */
export function orderProjectSessions<T extends Orderable>(sessions: readonly T[]): T[] {
  return waitingFirst([
    ...sortByActivity(sessions.filter((s) => s.pinned)),
    ...sortByActivity(sessions.filter((s) => !s.pinned)),
  ]);
}

interface DrawerSession {
  status: string;
  unread?: boolean;
  pendingAskCount?: number;
  queueFailed?: string;
  parked?: 'reminder' | 'upstream';
  goal?: { status: string };
}

function drawerTone(session: DrawerSession, hasRunningChild: boolean) {
  return conversationDotTone({
    status: session.queueFailed ? 'failed' : session.status,
    unread: session.unread,
    pendingAskCount: session.pendingAskCount,
    hasRunningChild,
    queued: (session.status === 'queued' && !session.queueFailed) || session.parked === 'upstream',
    hasPendingReminder: session.parked === 'reminder',
  });
}

/** 桌面 Active 栏目：运行 / 待提问 / 失败 / 未读 / 子会话在跑 / 续跑中 / 排队 / 等上游恢复 / 等提醒 */
export function isDrawerActive(session: DrawerSession, hasRunningChild: boolean): boolean {
  return drawerTone(session, hasRunningChild) !== 'idle' || session.goal?.status === 'active';
}

/** 桌面 activeConversationIds 同语义：排队、等上游恢复、等提醒排在其余活跃会话之后，两档各按活跃倒序。 */
export function orderDrawerActive<T extends Orderable & DrawerSession>(
  sessions: readonly T[],
  hasRunningChild: (id: string) => boolean
): T[] {
  const active = sortByActivity(
    sessions.filter((session) => isDrawerActive(session, hasRunningChild(session.id)))
  );
  const parked = (session: T) => {
    const tone = drawerTone(session, hasRunningChild(session.id));
    return tone === 'queued' || tone === 'reminder';
  };
  return [...active.filter((s) => !parked(s)), ...active.filter(parked)];
}
