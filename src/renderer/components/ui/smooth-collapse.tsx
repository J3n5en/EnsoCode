import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface SmoothCollapseProps {
  open: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * 基于 CSS grid-template-rows 的 GPU 加速折叠动画。
 * 适合自然高度的内容（列表、树节点）；不适合高度依赖兄弟元素尺寸的
 * flex 分配面板。
 */
export function SmoothCollapse({ open, children, className }: SmoothCollapseProps) {
  return (
    <div
      className={cn(
        'grid min-h-0 transition-[grid-template-rows,opacity] duration-200 ease-out',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      )}
    >
      <div className={cn('min-h-0 overflow-hidden', className)}>{children}</div>
    </div>
  );
}
