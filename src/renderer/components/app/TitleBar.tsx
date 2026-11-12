import { WINDOWS_CAPTION_BUTTONS_WIDTH } from '@shared/windowControls';
import { useRef } from 'react';
import { useNativeWindowControls } from '@/hooks/useNativeWindowControls';
import { cn } from '@/lib/utils';
import { LinuxWindowButtons, useWindowChromeKind } from './WindowChrome';

interface TitleBarProps {
  title?: string;
  className?: string;
  /** Optional no-drag actions; omitted props preserve the existing title bar layout. */
  actions?: React.ReactNode;
  /** Optional no-drag content shown in place of the title. */
  leading?: React.ReactNode;
  /**
   * 可选的居中内容使用独立覆盖层，固定在整个窗口正中。
   * 它保留左侧标题；macOS 隐藏标题以免挤占系统红绿灯。
   *
   * Center optional content over the entire window, independent of panel widths.
   * Keep the left title except on macOS, where traffic lights take precedence.
   */
  centered?: React.ReactNode;
}

/**
 * 无边框窗口标题栏：
 * - macOS: 仅作为拖拽区域（traffic lights 由系统渲染，左侧预留空间）
 * - Windows: 给原生窗口按钮预留空间，保留系统贴靠入口
 * - Linux: 自绘最小化/最大化/关闭按钮
 *
 * Preserve native caption controls and Snap Layouts on Windows, traffic lights
 * on macOS, and renderer caption controls on Linux.
 */
export function TitleBar({ title, className, actions, leading, centered }: TitleBarProps) {
  const kind = useWindowChromeKind();
  const isMac = kind === 'mac';
  const isWindows = kind === 'windows';
  const headerRef = useRef<HTMLElement>(null);
  useNativeWindowControls(headerRef);
  const nativeControlsInset = `calc(100% - env(titlebar-area-width, calc(100% - ${WINDOWS_CAPTION_BUTTONS_WIDTH}px)))`;

  return (
    <header
      ref={headerRef}
      data-enso="title-bar"
      data-native-window-controls={isWindows || undefined}
      style={isWindows ? { paddingRight: nativeControlsInset } : undefined}
      className={cn(
        // 固定像素高度：红绿灯位置 (y:16) 按 44px 高度对齐，不随 rem 缩放
        'drag-region relative flex h-[44px] shrink-0 items-center border-b bg-background',
        isMac ? 'pl-[84px] pr-3' : 'pl-3',
        className
      )}
    >
      {leading ? (
        <div className="no-drag flex items-center">{leading}</div>
      ) : !centered || !isMac ? (
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
      ) : null}

      {centered && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="no-drag pointer-events-auto">{centered}</div>
        </div>
      )}

      {actions && <div className="no-drag ml-auto flex items-center gap-1">{actions}</div>}

      {kind === 'linux' && (
        <div className={cn('flex h-full', !actions && 'ml-auto')}>
          <LinuxWindowButtons />
        </div>
      )}
    </header>
  );
}
