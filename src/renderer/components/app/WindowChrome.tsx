import { WINDOWS_CAPTION_BUTTONS_WIDTH } from '@shared/windowControls';
import { Copy, Minus, Square, X } from 'lucide-react';
import { createContext, type ReactNode, useContext, useRef } from 'react';
import { useNativeWindowControls } from '@/hooks/useNativeWindowControls';
import { useIsMobile } from '@/hooks/useViewport';
import { useWindowMaximized } from '@/hooks/useWindowMaximized';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/** mobile = 窄屏：沿用整行 TitleBar；web = 宽屏远程浏览器：同桌面外壳布局，但没有系统窗口控件 */
export type WindowChromeKind = 'mobile' | 'web' | 'mac' | 'windows' | 'linux';

export function useWindowChromeKind(): WindowChromeKind {
  if (useIsMobile()) return 'mobile';
  if (window.electronAPI.remote) return 'web';
  const { platform } = window.electronAPI.env;
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}

/**
 * 桌面外壳没有独立标题行：窗口的拖拽区、动作按钮与系统控件并进内容卡片的顶栏。
 * 由窗口根提供，顶栏行（ChromeRow）读取；为 null 时按旧布局渲染。
 */
export interface ShellChrome {
  /** 顶栏右端：动作按钮，窗口最右侧时还包含系统控件 */
  trailing: ReactNode;
}

export const ShellChromeContext = createContext<ShellChrome | null>(null);

export function useShellChrome(): ShellChrome | null {
  return useContext(ShellChromeContext);
}

/** 卡片顶栏：卡片上缘 8px + 36px（用 px，不随 rem 缩放） 与红绿灯/Windows 原生按钮的 44px 标题区对齐 */
export function ChromeRow({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  const shell = useShellChrome();
  return (
    <div
      {...rest}
      className={cn(
        'flex shrink-0 items-center gap-1 px-2',
        shell ? 'drag-region h-[36px] pr-0' : 'py-1',
        className
      )}
    >
      {children}
      {shell && (
        <div className="ml-auto flex shrink-0 items-center gap-1 self-stretch pr-2 has-[[data-window-controls]]:pr-0">
          {shell.trailing}
        </div>
      )}
    </div>
  );
}

/**
 * 窗口最右侧的系统控件位：Windows 给原生按钮 overlay 留白，Linux 自绘。
 * edgeGap 是所在行右缘到窗口右缘的距离（卡片外边距）。
 */
export function WindowControls({
  kind,
  edgeGap = 0,
}: {
  kind: WindowChromeKind;
  edgeGap?: number;
}) {
  if (kind === 'windows') return <WindowsCaptionInset edgeGap={edgeGap} />;
  if (kind === 'linux') return <LinuxWindowButtons />;
  return null;
}

function WindowsCaptionInset({ edgeGap }: { edgeGap: number }) {
  const ref = useRef<HTMLDivElement>(null);
  // overlay 颜色取自这块留白：它和原生按钮都坐在画布上
  useNativeWindowControls(ref);
  return (
    <div
      ref={ref}
      aria-hidden
      data-window-controls
      data-native-window-controls
      className="shrink-0 self-stretch bg-canvas text-foreground"
      style={{
        width: `max(0px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - ${WINDOWS_CAPTION_BUTTONS_WIDTH}px)) - ${edgeGap}px))`,
      }}
    />
  );
}

export function LinuxWindowButtons() {
  const { t } = useI18n();
  const maximized = useWindowMaximized();
  return (
    <div data-window-controls className="no-drag flex h-full items-center self-stretch">
      <button
        type="button"
        className="flex h-full w-12 items-center justify-center hover:bg-muted"
        onClick={() => window.electronAPI.window.minimize()}
        aria-label={t('Minimize')}
        title={t('Minimize')}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="flex h-full w-12 items-center justify-center hover:bg-muted"
        onClick={() => window.electronAPI.window.maximize()}
        aria-label={maximized ? t('Restore') : t('Maximize')}
        title={maximized ? t('Restore') : t('Maximize')}
      >
        {maximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        className="flex h-full w-12 items-center justify-center hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => window.electronAPI.window.close()}
        aria-label={t('Close')}
        title={t('Close')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
