import { ENSO_AGENT_TYPE_KEY } from '@shared/builtinAgents';
import { Copy, Minus, Sparkles, Square, X } from 'lucide-react';
import { useWindowMaximized } from '@/hooks/useWindowsWindowChrome';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface TitleBarProps {
  title?: string;
  className?: string;
  /** Optional no-drag actions; omitted props preserve the existing title bar layout. */
  actions?: React.ReactNode;
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
 * - Windows/Linux: 自绘最小化/最大化/关闭按钮
 */
export function TitleBar({ title, className, actions }: TitleBarProps) {
  const { t } = useI18n();
  const isMac = window.electronAPI.env.platform === 'darwin';
  const maximized = useWindowMaximized();

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

      {actions && <div className="no-drag ml-auto flex items-center gap-1">{actions}</div>}

      {!isMac && (
        <div className={cn('no-drag flex h-full items-center', !actions && 'ml-auto')}>
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
      )}
    </header>
  );
}
