import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  /** 拖拽开始/结束通知(消费方可借此暂停宽度动画,避免 spring 追赶抖动) */
  onResizingChange?: (resizing: boolean) => void;
}

/** 侧边栏缘的拖拽手柄:视觉 1px,命中区左右各扩 4px */
export function ResizeHandle({ onResize, onResizingChange }: ResizeHandleProps) {
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
    <div className="relative w-px shrink-0 bg-border">
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          '-left-1 -right-1 absolute inset-y-0 z-10 cursor-col-resize',
          'after:absolute after:inset-y-0 after:left-1 after:w-px after:transition-colors hover:after:bg-ring',
          resizing && 'after:bg-ring'
        )}
      />
    </div>
  );
}
