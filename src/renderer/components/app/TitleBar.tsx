import { Minus, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TitleBarProps {
  title?: string;
  className?: string;
}

/**
 * 无边框窗口标题栏：
 * - macOS: 仅作为拖拽区域（traffic lights 由系统渲染，左侧预留空间）
 * - Windows/Linux: 自绘最小化/最大化/关闭按钮
 */
export function TitleBar({ title, className }: TitleBarProps) {
  const isMac = window.electronAPI.env.platform === 'darwin';

  return (
    <header
      className={cn(
        // 固定像素高度：红绿灯位置 (y:16) 按 44px 高度对齐，不随 rem 缩放
        'drag-region flex h-[44px] shrink-0 items-center border-b bg-background',
        isMac ? 'pl-[84px] pr-3' : 'pl-3',
        className
      )}
    >
      <span className="text-sm font-medium text-muted-foreground">{title}</span>

      {!isMac && (
        <div className="no-drag ml-auto flex h-full items-center">
          <button
            type="button"
            className="flex h-full w-12 items-center justify-center hover:bg-muted"
            onClick={() => window.electronAPI.window.minimize()}
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-full w-12 items-center justify-center hover:bg-muted"
            onClick={() => window.electronAPI.window.maximize()}
          >
            <Square className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="flex h-full w-12 items-center justify-center hover:bg-destructive hover:text-destructive-foreground"
            onClick={() => window.electronAPI.window.close()}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </header>
  );
}
