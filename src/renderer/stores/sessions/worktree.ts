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
    `This session's workspace has moved to: ${path}\n` +
    'Absolute paths mentioned earlier in this conversation are stale. ' +
    'Re-resolve paths against the new workspace root before reading or editing files.\n' +
    '</workspace-migrated>'
  );
}

/** worktree 清理/丢失后回退主工作树的提醒（语义同上，方向相反） */
export function workspaceFallbackNote(path: string): string {
  return (
    '<workspace-migrated>\n' +
    `This session's isolated worktree is gone. The workspace is now the main working tree: ${path}\n` +
    'Absolute paths mentioned earlier in this conversation are stale. ' +
    'Re-resolve paths against the new workspace root before reading or editing files.\n' +
    '</workspace-migrated>'
  );
}
