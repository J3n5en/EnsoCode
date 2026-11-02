import type { ShellFailure } from '@shared/types/agent';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import {
  quietDuration,
  RERUN_TIMEOUT_SEC,
  rerunActions,
  rerunPrompt,
  rerunViaComposer,
  SHELL_FAILURE_HINT_KEYS,
  SHELL_FAILURE_LABEL_KEYS,
  yieldCountdown,
} from '@/lib/shellStatus';
import { cn } from '@/lib/utils';
import { insertComposerText, requestFocusComposer } from './composerMentionBridge';

function useSecondTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const RING_R = 5;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 运行中命令的状态：让位倒计时环 + 静默徽章。
 * 静默时长由输出快照最后一次变化的时间在渲染层自算，不需要 worker 发心跳。
 */
export function ShellRunStatus({
  startedAt,
  deadlineAt,
  output,
}: {
  startedAt: number | null | undefined;
  deadlineAt: number | undefined;
  output: string;
}) {
  const { t } = useI18n();
  const now = useSecondTick();
  const lastChange = useRef<{ output: string; at: number }>({
    output,
    at: startedAt ?? Date.now(),
  });
  if (lastChange.current.output !== output) lastChange.current = { output, at: Date.now() };
  const countdown = yieldCountdown(startedAt, deadlineAt, now);
  const quiet = quietDuration(lastChange.current.at, now);
  if (!countdown && quiet === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground/70 tabular-nums">
      {quiet !== null && (
        <span data-shell-quiet className="rounded bg-muted px-1">
          {t('No output for {{seconds}}s', { seconds: Math.floor(quiet / 1000) })}
        </span>
      )}
      {countdown && countdown.remainingMs > 0 && (
        <span
          className="flex items-center gap-0.5"
          title={t('Moves to background in {{seconds}}s', {
            seconds: Math.ceil(countdown.remainingMs / 1000),
          })}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="6" cy="6" r={RING_R} fill="none" stroke="currentColor" opacity="0.25" />
            <circle
              cx="6"
              cy="6"
              r={RING_R}
              fill="none"
              stroke="currentColor"
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - countdown.fraction)}
              transform="rotate(-90 6 6)"
            />
          </svg>
          {Math.ceil(countdown.remainingMs / 1000)}s
        </span>
      )}
    </span>
  );
}

function failureLabel(failure: ShellFailure, t: ReturnType<typeof useI18n>['t']): string {
  if (failure.kind === 'exit_nonzero' && failure.exitCode === undefined) return t('Failed');
  return t(SHELL_FAILURE_LABEL_KEYS[failure.kind], { code: failure.exitCode ?? '' });
}

/** 时间线行头的失败徽章 */
export function ShellFailureBadge({ failure }: { failure: ShellFailure }) {
  const { t } = useI18n();
  return (
    <span
      data-shell-failure={failure.kind}
      className={cn(
        'shrink-0 rounded px-1 text-[10px]',
        failure.retryable ? 'bg-muted text-muted-foreground' : 'bg-destructive/10 text-destructive'
      )}
    >
      {failureLabel(failure, t)}
    </span>
  );
}

/**
 * 终端输出底部的失败状态条：分类 + 用户下一步 + 动作。
 * 截止被杀的命令给「转后台重跑」「提高 timeout 重跑」：把请求填进输入框由用户确认发送；其余只给复制命令。
 */
export function ShellFailureBar({
  failure,
  command,
}: {
  failure: ShellFailure | undefined;
  command: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  if (!failure) return null;
  const hint = SHELL_FAILURE_HINT_KEYS[failure.kind];
  const actions = rerunActions(failure);
  return (
    <div
      data-shell-status={failure.kind}
      className="mt-2 flex items-center gap-2 border-t border-current/10 pt-1.5 text-[11px] opacity-80"
    >
      <span className="shrink-0 font-medium">{failureLabel(failure, t)}</span>
      {hint && <span className="min-w-0 flex-1">{t(hint)}</span>}
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          data-shell-rerun={action}
          onClick={() => {
            rerunViaComposer(
              rerunPrompt(action, command, t),
              insertComposerText,
              requestFocusComposer
            );
          }}
          className="flex shrink-0 items-center gap-1 underline-offset-2 hover:underline hover:opacity-100"
        >
          {action === 'background'
            ? t('Rerun in background')
            : t('Rerun with {{seconds}}s timeout', { seconds: RERUN_TIMEOUT_SEC })}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1000);
          });
        }}
        className="ml-auto flex shrink-0 items-center gap-1 hover:opacity-100"
        title={t('Copy command')}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {t('Copy command')}
      </button>
    </div>
  );
}
