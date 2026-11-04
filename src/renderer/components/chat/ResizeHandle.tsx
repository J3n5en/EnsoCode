import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  /** 拖拽开始/结束通知(消费方可借此暂停宽度动画,避免 spring 追赶抖动) */
  onResizingChange?: (resizing: boolean) => void;
  /** 卡片间 8px 画布缝本身就是手柄，平时不画分隔线 */
  gap?: boolean;
  /** 零宽、不画线，命中区只落在右侧卡片边缘：左侧贴边的是侧栏滚动条，不能被手柄盖住 */
  edge?: boolean;
}

/** 侧边栏缘的拖拽手柄:视觉 1px,命中区左右各扩 4px；gap 模式命中区即 8px 缝 */
export function ResizeHandle({
  onResize,
  onResizingChange,
  gap = false,
  edge = false,
}: ResizeHandleProps) {
  const [resizing, setResizing] = useState(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      onResizingChange?.(true);
      lastX.current = e.clientX;
      const handleMove = (ev: MouseEvent) => {
        onResize(ev.clientX - lastX.current);
        lastX.current = ev.clientX;
      };
      const handleUp = () => {
        setResizing(false);
        onResizingChange?.(false);
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleUp);
      };
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleUp);
    },
    [onResize, onResizingChange]
  );

  return (
    <div className={cn('relative shrink-0', edge ? 'w-0' : gap ? 'w-[8px]' : 'w-px bg-border')}>
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          'absolute inset-y-0 z-10 cursor-col-resize',
          'after:absolute after:inset-y-0 after:w-px after:transition-colors hover:after:bg-ring',
          edge
            ? 'left-0 -right-1.5 after:left-0'
            : gap
              ? 'inset-x-0 after:left-1/2'
              : '-left-1 -right-1 after:left-1',
          resizing && 'after:bg-ring'
        )}
      />
      {/* 拖拽期间遮住 iframe（插件页等），否则鼠标进入 iframe 后父文档收不到 mousemove/mouseup */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
