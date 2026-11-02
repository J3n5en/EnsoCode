import { SHELL_QUIET_MS, type ShellFailureKind } from '@shared/types/agent';

/** 让位倒计时：deadlineAt 是 worker 下发的前台让位时刻（与显式 timeout 取小） */
export function yieldCountdown(
  startedAt: number | null | undefined,
  deadlineAt: number | undefined,
  now: number
): { remainingMs: number; fraction: number } | null {
  if (startedAt == null || deadlineAt === undefined || deadlineAt <= startedAt) return null;
  const remainingMs = Math.max(0, deadlineAt - now);
  return { remainingMs, fraction: Math.min(1, remainingMs / (deadlineAt - startedAt)) };
}

/** 自最后一次输出变化起的静默时长；未达阈值返回 null */
export function quietDuration(
  lastChangeAt: number,
  now: number,
  quietMs: number = SHELL_QUIET_MS
): number | null {
  const quiet = now - lastChangeAt;
  return quiet >= quietMs ? quiet : null;
}

/** 失败徽章文案（i18n key）；exit_nonzero 带 {{code}} */
export const SHELL_FAILURE_LABEL_KEYS: Record<ShellFailureKind, string> = {
  exit_nonzero: 'Exit {{code}}',
  deadline: 'Killed at timeout',
  stopped_by_user: 'Stopped by you',
  tty_required: 'Needs terminal',
  auth_required: 'Needs login',
  not_found: 'Command not found',
  not_executable: 'Not executable',
  binary_output: 'Binary output',
  output_truncated: 'Log truncated',
};

/** 需要用户动手的分类给出下一步（i18n key） */
export const SHELL_FAILURE_HINT_KEYS: Partial<Record<ShellFailureKind, string>> = {
  deadline: 'Killed when its timeout was reached. Raise the timeout or run it in the background.',
  tty_required:
    'Needs an interactive terminal. Use a non-interactive flag (such as --yes) or run it in your own terminal.',
  auth_required: 'Needs credentials. Sign in from your own terminal, then retry.',
  not_found: 'The program is not installed or not on PATH.',
};
