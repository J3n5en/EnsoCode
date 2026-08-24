import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
}

/** 侧边栏右缘的拖拽手柄（参考 EnsoAI ResizeHandle，按 px 增量回调） */
export function ResizeHandle({ onResize }: ResizeHandleProps) {
  const [resizing, setResizing] = useState(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      lastX.current = e.clientX;
      const handleMove = (ev: MouseEvent) => {
        onResize(ev.clientX - lastX.current);
        lastX.current = ev.clientX;
      };
      const handleUp = () => {
        setResizing(false);
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleUp);
      };
      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleUp);
    },
    [onResize]
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        'w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring',
        resizing && 'bg-ring'
      )}
    />
  );
}
