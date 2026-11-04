import type { SessionWorktree, WorktreeStatus } from '@shared/types/worktree';
import { GitBranch } from 'lucide-react';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { worktreeDisplayName } from './worktreeUi';

export function worktreeHoverText(
  worktree: SessionWorktree,
  status: WorktreeStatus | undefined,
  t: TFunction
): string {
  const state =
    status?.exists === false
      ? t('Worktree missing')
      : !status
        ? t('Worktree status unknown')
        : [
            status.dirty ? t('Uncommitted changes') : t('Working tree clean'),
            ...(status.ahead > 0 ? [t('{{n}} unmerged commits', { n: status.ahead })] : []),
          ].join(' · ');
  return [worktreeDisplayName(worktree), worktree.branch, worktree.path, state].join('\n');
}

/** 会话行内的 worktree 标记：只占一个分支图标，名称、分支、路径与状态放进悬停提示 */
export function WorktreeBadge({
  worktree,
  status,
}: {
  worktree: SessionWorktree;
  status?: WorktreeStatus;
}) {
  const { t } = useI18n();
  return (
    <span
      data-slot="worktree-label"
      title={worktreeHoverText(worktree, status, t)}
      className="flex shrink-0 items-center"
    >
      <GitBranch
        className={cn(
          'size-2.75',
          status?.exists === false
            ? 'text-destructive'
            : status?.dirty
              ? 'text-warning'
              : (status?.ahead ?? 0) > 0
                ? 'text-info'
                : 'text-subtle-foreground'
        )}
      />
    </span>
  );
}
