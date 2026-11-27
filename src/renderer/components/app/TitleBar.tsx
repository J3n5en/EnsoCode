import { WINDOWS_CAPTION_BUTTONS_WIDTH } from '@shared/windowControls';
import { useRef } from 'react';
import { useNativeWindowControls } from '@/hooks/useNativeWindowControls';
import { cn } from '@/lib/utils';
import { LinuxWindowButtons, useWindowChromeKind } from './WindowChrome';

interface TitleBarProps {
  title?: string;
  className?: string;
  /** 可选的 no-drag 操作区；不传时保持原有标题栏布局。 */
  actions?: React.ReactNode;
  /** 可选的 no-drag 内容，显示在标题的位置。 */
  leading?: React.ReactNode;
  /**
   * 可选的居中内容使用独立覆盖层，固定在整个窗口正中。
   * 它保留左侧标题；macOS 隐藏标题以免挤占系统红绿灯。
   */
  centered?: React.ReactNode;
  /** 可选的中段内容，占满 leading 与 actions 之间的空白；不在拖拽区内，空白处需自带独立的 drag 元素 */
  middle?: React.ReactNode;
}

/**
 * 无边框窗口标题栏：
 * - macOS: 仅作为拖拽区域（traffic lights 由系统渲染，左侧预留空间）
 * - Windows: 给原生窗口按钮预留空间，保留系统贴靠入口
 * - Linux: 自绘最小化/最大化/关闭按钮
 *
 * header 自身不设 drag：macOS 原生命中测试不认 drag 祖先里的 no-drag 例外，按钮点击会被当成拖窗口。
 * 拖拽只交给不含任何可交互元素的独立空白元素。
 */
export function TitleBar({ title, className, actions, leading, centered, middle }: TitleBarProps) {
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
        'relative flex h-[44px] shrink-0 items-center border-b bg-background',
        // 右缘动作别贴屏幕边；Linux 自绘窗口按钮要贴窗口右缘，Windows 由内联 padding 给原生按钮让位
        isMac ? 'pl-[84px]' : 'pl-3',
        kind !== 'linux' && 'pr-3',
        className
      )}
    >
      {leading ? (
        <div className="no-drag flex shrink-0 items-center">{leading}</div>
      ) : !centered || !isMac ? (
        <span className="shrink-0 text-sm font-medium text-muted-foreground">{title}</span>
      ) : null}

      {middle}

      <div aria-hidden className={cn('drag-region h-full min-w-2', !middle && 'flex-1')} />

      {centered && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="no-drag pointer-events-auto">{centered}</div>
        </div>
      )}

      {actions && <div className="no-drag ml-auto flex shrink-0 items-center gap-1">{actions}</div>}

      {kind === 'linux' && (
        <div className={cn('flex h-full shrink-0', !actions && 'ml-auto')}>
          <LinuxWindowButtons />
        </div>
      )}
    </header>
  );
}
