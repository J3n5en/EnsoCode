/**
 * 会话级 worktree 隔离的纯 helper（store 与 UI 共用）。
 * 产品决策见 docs/plans/2026-08-22-enso-code-design.md「trust 与 isolation」。
 */

import type { WorktreeStatus } from '@shared/types/worktree';

/** worktree 有未落地成果（未提交或领先未合并），清理/归档/删除前需要确认 */
export function worktreeHasPendingWork(status: WorktreeStatus | undefined): boolean {
  if (!status) return false;
  return status.dirty || status.ahead > 0;
}

/**
 * 工作区迁移提醒：随下一条用户消息前置注入。
 * 此前对话里的绝对路径全部失效，必须显式告知 agent，否则它会继续往旧工作区写。
 */
export function workspaceMigratedNote(path: string): string {
  return (
    '<workspace-migrated>\n' +
    `FYI: this session's workspace has moved to: ${path}\n` +
    'Absolute paths mentioned earlier in this conversation are stale; ' +
    'resolve paths against the new workspace root when you read or edit files.\n' +
    'This is background information only — not a task, request, or goal. ' +
    'Do not act on it and do not call goal tools for it; just answer the message below.\n' +
    '</workspace-migrated>'
  );
}

/** worktree 清理/丢失后回退主工作树的提醒（语义同上，方向相反） */
export function workspaceFallbackNote(path: string): string {
  return (
    '<workspace-migrated>\n' +
    `FYI: this session's isolated worktree is gone. The workspace is now the main working tree: ${path}\n` +
    'Absolute paths mentioned earlier in this conversation are stale; ' +
    'resolve paths against the new workspace root when you read or edit files.\n' +
    'This is background information only — not a task, request, or goal. ' +
    'Do not act on it and do not call goal tools for it; just answer the message below.\n' +
    '</workspace-migrated>'
  );
}
