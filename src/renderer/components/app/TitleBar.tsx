import { ENSO_AGENT_TYPE_KEY } from '@shared/builtinAgents';
import { WINDOWS_CAPTION_BUTTONS_WIDTH } from '@shared/windowControls';
import { Sparkles } from 'lucide-react';
import { useRef } from 'react';
import { useNativeWindowControls } from '@/hooks/useNativeWindowControls';
import { useI18n } from '@/i18n';
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
   * 可选的居中内容使用独立覆盖层，在 Windows 上避开原生按钮区域。
   * 它保留左侧标题；macOS 隐藏标题以免挤占系统红绿灯。
   *
   * Center optional content in an overlay that excludes native Windows controls.
   * Keep the left title except on macOS, where traffic lights take precedence.
   */
  centered?: React.ReactNode;
  /** 居中内容对齐的横向区间（窗口坐标，如对话卡片）；缺省按整行居中 */
  centerOver?: { left: number; right: number } | null;
}

export function SummonEnsoButton({ label = true }: { label?: boolean }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => {
        void window.electronAPI.window.summonAgent({ typeKey: ENSO_AGENT_TYPE_KEY });
      }}
      aria-label={t('Ask Enso')}
      title={t('Ask Enso')}
    >
      <Sparkles className="h-3.5 w-3.5" />
      {label && <span>{t('Ask Enso')}</span>}
    </button>
  );
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
export function TitleBar({
  title,
  className,
  actions,
  leading,
  centered,
  centerOver,
}: TitleBarProps) {
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
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={
            centerOver
              ? { left: centerOver.left, right: `calc(100% - ${centerOver.right}px)` }
              : isWindows
                ? { right: nativeControlsInset }
                : undefined
          }
        >
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
