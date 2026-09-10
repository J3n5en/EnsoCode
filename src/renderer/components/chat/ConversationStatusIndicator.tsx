import type { CoworkerTabTone } from '@shared/conversationDotTone';
import { CircleHelp } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** 会话状态指示：ask_user 等待回答时用琥珀色问号（不闪烁），其余状态沿用圆点语义。 */
export type ConversationIndicatorTone = CoworkerTabTone | 'unread';

// 空心=无事发生,实心=有状态;空心圈需要 8px 才能稳定画出 1px 描边
const DOT_SIZE = { sm: 'size-2', md: 'size-2.5' } as const;
const ICON_SIZE = { sm: 'h-3 w-3', md: 'h-3.5 w-3.5' } as const;

export function ConversationStatusIndicator({
  tone,
  size = 'sm',
  title,
  className,
}: {
  tone: ConversationIndicatorTone;
  size?: keyof typeof DOT_SIZE;
  /** 非 waiting 态的悬停提示（waiting 态固定为「等待你回答」） */
  title?: string;
  className?: string;
}) {
  const { t } = useI18n();
  if (tone === 'waiting') {
    const label = t('Waiting for your answer');
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-slot="conversation-status"
        data-tone={tone}
        className={cn('flex shrink-0 items-center text-amber-500', className)}
      >
        <CircleHelp className={cn(ICON_SIZE[size], 'stroke-[2.5]')} aria-hidden />
      </span>
    );
  }
  return (
    <span
      data-slot="conversation-status"
      data-tone={tone}
      title={title}
      className={cn(
        'shrink-0 rounded-full',
        DOT_SIZE[size],
        tone === 'attention' && 'animate-pulse bg-destructive',
        tone === 'running' && 'animate-pulse bg-blue-500',
        tone === 'failed' && 'bg-destructive',
        tone === 'unread' && 'bg-green-500',
        tone === 'idle' && 'border border-muted-foreground/50',
        className
      )}
    />
  );
}
