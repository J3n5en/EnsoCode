import { Target } from 'lucide-react';
import { cn } from '@/lib/utils';

/** goal 相关的统一外观：目标状态条与目标续跑卡片共用同一套框和图标 */
export const GOAL_FRAME = 'rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs';

export function GoalIcon({ className }: { className?: string }) {
  return <Target className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className)} />;
}

/** 系统注入块（子代理通知 / 后台任务 / 会话更新 / 定时）共用：虚线框 + 小图标 + 首行 */
export const NOTICE_BOX =
  'w-full overflow-hidden rounded-lg border border-dashed border-border/60 text-xs text-muted-foreground';
export const NOTICE_FRAME = cn(NOTICE_BOX, 'px-3 py-2');
export const NOTICE_ICON = 'mt-0.5 h-3.5 w-3.5 shrink-0';
