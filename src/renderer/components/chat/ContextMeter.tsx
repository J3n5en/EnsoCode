import { cn } from '@/lib/utils';
import type { ContextBarSegment } from './contextBreakdown';

/** 上下文进度条转为警示色的阈值 */
const WARNING_PERCENT = 70;
/** 分段条从 80% 起整体变琥珀色 */
export const CONTEXT_BAR_WARN_PERCENT = 80;

export const SEGMENT_COLOR: Record<ContextBarSegment['kind'], string> = {
  system: 'bg-brand',
  memory: 'bg-warning',
  tools: 'bg-info',
  skills: 'bg-success',
  files: 'bg-foreground/70',
  results: 'bg-foreground/40',
  chat: 'bg-muted-foreground/70',
};

/** 上下文分段条：每段一类占用，悬停某类时其余段变淡。 */
export function ContextBar({
  segments,
  highlight,
  className,
}: {
  segments: readonly ContextBarSegment[];
  highlight?: ContextBarSegment['kind'];
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-1 w-16 shrink-0 gap-px overflow-hidden rounded-full bg-muted-foreground/15',
        className
      )}
    >
      {segments.map((segment) => (
        <span
          key={segment.kind}
          className={cn(
            'block h-full transition-opacity',
            SEGMENT_COLOR[segment.kind],
            highlight && highlight !== segment.kind && 'opacity-25'
          )}
          style={{ width: `${segment.width}%` }}
        />
      ))}
    </span>
  );
}

/** 上下文占用进度条，比纯数字更直观地传达「还剩多少」。 */
export function ContextMeter({ percent, critical }: { percent: number; critical: boolean }) {
  return (
    <span
      aria-hidden
      className="h-1 w-7 shrink-0 overflow-hidden rounded-full bg-muted-foreground/20"
    >
      <span
        className={cn(
          'block h-full rounded-full',
          critical
            ? 'bg-destructive'
            : percent >= WARNING_PERCENT
              ? 'bg-warning'
              : 'bg-muted-foreground/70'
        )}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}
