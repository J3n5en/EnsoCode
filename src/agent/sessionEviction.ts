import type { NodeStatus } from '@shared/types/agent';

/** 空闲这么久的父会话从 worker 释放（jsonl 留盘，再次查看时 renderer 自动 resume）。
 *  比 renderer 正文缓存（5 分钟）长得多：resume 要重跑 runtime/skill/MCP/回放，代价数秒。 */
export const IDLE_SESSION_TTL_MS = 30 * 60_000;
export const EVICTION_SWEEP_INTERVAL_MS = 60_000;

export interface EvictionCandidate {
  sessionId: string;
  isChild: boolean;
  status: NodeStatus;
  lastActivityAt: number;
  /** 挂起的 approval / ask / capability / 后台任务 / 待投递提醒 / 进行中的轮次 */
  hasPendingWork: boolean;
  /** 仍有 coworker / subagent / 子会话挂在树上 */
  hasChildren: boolean;
}

/** 挑出可安全 release 的父会话 id。子会话从不单独回收，随父会话一起释放。 */
export function selectEvictable(
  candidates: readonly EvictionCandidate[],
  pinned: ReadonlySet<string>,
  now: number,
  ttl = IDLE_SESSION_TTL_MS
): string[] {
  return candidates
    .filter(
      (c) =>
        !c.isChild &&
        !pinned.has(c.sessionId) &&
        c.status === 'idle' &&
        !c.hasPendingWork &&
        !c.hasChildren &&
        now - c.lastActivityAt >= ttl
    )
    .map((c) => c.sessionId);
}
