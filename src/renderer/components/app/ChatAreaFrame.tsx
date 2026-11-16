import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * 聊天区外框。秘书引导打开时整块停止绘制：透明背景（html.bg-image-enabled）下
 * 面板色 alpha 为 0，引导层背后的空会话会整块透上来，聊天区里的 z-20/z-30 弹层
 * 还会压到引导之上。用 visibility 而不是卸载，关掉引导后会话的滚动位置与输入状态
 * 原样恢复。
 */
export function ChatAreaFrame({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', hidden && 'invisible')}>
      {children}
    </div>
  );
}
