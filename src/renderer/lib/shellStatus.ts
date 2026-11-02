import { SHELL_QUIET_MS, type ShellFailure, type ShellFailureKind } from '@shared/types/agent';

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

/** 「提高 timeout 重跑」填入的新截止（秒） */
export const RERUN_TIMEOUT_SEC = 600;

export type RerunAction = 'background' | 'timeout';

/**
 * 失败卡可给的重跑动作：只有截止被杀的命令换个跑法有意义；
 * 需要终端 / 认证的原样重跑注定再失败，普通非零退出要先修原因。
 */
export function rerunActions(failure: ShellFailure | undefined): RerunAction[] {
  return failure?.kind === 'deadline' ? ['background', 'timeout'] : [];
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 填进输入框的重跑请求：由用户确认后发送，模型按改动点重新调用命令工具 */
export function rerunPrompt(action: RerunAction, command: string, t: Translate): string {
  const fenced = `\`\`\`\n${command}\n\`\`\``;
  return action === 'background'
    ? t('Rerun this command with background: true:\n\n{{command}}', { command: fenced })
    : t('Rerun this command with timeout: {{seconds}}:\n\n{{command}}', {
        seconds: RERUN_TIMEOUT_SEC,
        command: fenced,
      });
}

/** 复用输入框插入机制（composerMentionBridge）：填入并聚焦，不自动发送 */
export function rerunViaComposer(
  text: string,
  insert: (text: string) => boolean,
  focus: () => boolean
): boolean {
  if (!insert(text)) return false;
  focus();
  return true;
}
