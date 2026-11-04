import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StepNodeState = 'running' | 'reviewing' | 'ok' | 'error';

/** 时间线节点：圆形图标，运行中强调色转圈，出错红边 */
export function StepNode({ icon: Icon, state }: { icon: LucideIcon; state: StepNodeState }) {
  const busy = state === 'running' || state === 'reviewing';
  return (
    <span
      className={cn(
        'relative flex size-[22px] shrink-0 items-center justify-center rounded-full border text-muted-foreground',
        busy && 'border-transparent text-brand',
        state === 'error' && 'border-destructive/40 text-destructive'
      )}
    >
      <Icon className="size-3" />
      {busy && (
        <span className="absolute -inset-px animate-spin rounded-full border-[1.5px] border-brand/20 border-t-brand" />
      )}
    </span>
  );
}

/** 日志式工具行的前缀：静止为淡色小圆点，运行中强调色转圈，出错红点 */
export function StepDot({ state }: { state: StepNodeState }) {
  const busy = state === 'running' || state === 'reviewing';
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {busy ? (
        <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-border border-t-brand" />
      ) : state === 'error' ? (
        <span className="size-1.5 rounded-full bg-destructive" />
      ) : (
        <span className="size-1 rounded-full bg-current opacity-60" />
      )}
    </span>
  );
}
