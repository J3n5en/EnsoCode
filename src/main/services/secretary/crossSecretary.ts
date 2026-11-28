import { realpathSync } from 'node:fs';
import { queuedStartOf } from '@shared/secretary/queuedSession';
import { DEFAULT_SECRETARY_ID } from './registry';
import { countsAsRunning } from './results';
import { secretaryContexts, secretaryRegistry } from './secretaries';
import { SecretaryStore } from './store';

/**
 * 跨秘书的事实：谁在管某个会话、全部秘书合计在跑多少、哪些 worktree 正被用着。
 * 只读各秘书自己的文件，不改任何东西；写入由各秘书的端口在同步段里完成。
 */

function originOwner(row: Record<string, unknown> | undefined): string | null {
  const origin = row?.secretaryOrigin;
  if (!origin || typeof origin !== 'object') return null;
  const id = (origin as { secretaryId?: unknown }).secretaryId;
  // 旧数据没有秘书 id：那时只有一个秘书，就是迁移出的 default
  return typeof id === 'string' ? id : DEFAULT_SECRETARY_ID;
}

/** 管理这个会话的秘书 id：先看各秘书的派发 / 接管记录，再看会话行上的派出归属 */
export function managerOfSync(
  conversationId: string,
  rows: Readonly<Record<string, Record<string, unknown>>>
): string | null {
  const contexts = secretaryContexts();
  for (const ctx of contexts) {
    if (Object.hasOwn(new SecretaryStore(ctx.dir).dispatchView().dispatched, conversationId))
      return ctx.id;
  }
  const origin = originOwner(rows[conversationId]);
  return origin && contexts.some((ctx) => ctx.id === origin) ? origin : null;
}

export async function managerOf(conversationId: string): Promise<string | null> {
  const { readPersistedConversations } = await import('../../ipc/settings');
  return managerOfSync(conversationId, readPersistedConversations());
}

/** 别的秘书在管时返回它的名字（没设置名字就用 id）；本秘书在管或没人管返回 null */
export async function managedElsewhere(
  selfId: string,
  conversationId: string
): Promise<string | null> {
  const owner = await managerOf(conversationId);
  if (!owner || owner === selfId) return null;
  const ctx = secretaryContexts().find((candidate) => candidate.id === owner);
  return (ctx && new SecretaryStore(ctx.dir).profile()?.name) || owner;
}

/** 全部秘书合计在跑的派发数：与各自的上限同一个判定，接管来的会话不计 */
export async function runningTotal(): Promise<{ running: number; max: number }> {
  const { readPersistedConversations } = await import('../../ipc/settings');
  const { observedSessionStatus } = await import('../../ipc/agent');
  const rows = readPersistedConversations();
  let running = 0;
  for (const ctx of secretaryContexts()) {
    for (const record of Object.values(new SecretaryStore(ctx.dir).dispatchView().dispatched)) {
      if (record.takeover) continue;
      if (
        countsAsRunning(
          record,
          rows[record.conversationId],
          observedSessionStatus(record.conversationId)
        )
      )
        running += 1;
    }
  }
  return { running, max: secretaryRegistry().maxRunningTotal() };
}

/**
 * 任何秘书正在跑或还在排队的派发会话所在的 worktree（真实路径）：清理时一律不碰。
 * 排队会话的分支还停在基线上，看起来「已合入」，不挡就会被当成可清理
 */
export async function runningWorktreePaths(): Promise<Set<string>> {
  const { readPersistedConversations } = await import('../../ipc/settings');
  const { observedSessionStatus } = await import('../../ipc/agent');
  const { sessionWorktree } = await import('../../ipc/worktree');
  const rows = readPersistedConversations();
  const ids = new Set<string>();
  for (const ctx of secretaryContexts()) {
    for (const record of Object.values(new SecretaryStore(ctx.dir).dispatchView().dispatched)) {
      const status = observedSessionStatus(record.conversationId);
      if (countsAsRunning(record, rows[record.conversationId], status))
        ids.add(record.conversationId);
    }
  }
  for (const [id, row] of Object.entries(rows)) if (queuedStartOf(row)) ids.add(id);
  const paths = new Set<string>();
  for (const id of ids) {
    const worktree = sessionWorktree(id)?.path;
    if (!worktree) continue;
    try {
      paths.add(realpathSync(worktree));
    } catch {
      paths.add(worktree);
    }
  }
  return paths;
}
