import type { BrowserTabState } from '@shared/types/browser';
import type { DockviewPanelApi } from 'dockview-react';
import { ArrowLeft, ArrowRight, Globe, Hand, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';

const EMPTY: BrowserTabState = {
  tabId: null,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  locked: false,
};

type Rect = { x: number; y: number; width: number; height: number };

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

/**
 * 真实网页由 Main 的 WebContentsView 画在主窗口上；这里只是一块占位 div，
 * 负责把自己的屏幕矩形与可见性报给 Main，并渲染地址栏。
 * 侧栏宽度动画 / 拖拽期间矩形连续变化，用 rAF 轮询比事件拼接更稳。
 */
export function BrowserView({
  conversationId,
  panelApi,
}: {
  conversationId: string;
  panelApi: DockviewPanelApi;
}) {
  const { t } = useI18n();
  const sidebarOpen = useSidePanelStore((s) => s.open);
  const isActiveConversation = useSessionsStore((s) => s.activeId === conversationId);
  const [state, setState] = useState<BrowserTabState>(EMPTY);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef<Rect | null | undefined>(undefined);

  useEffect(() => {
    return window.electronAPI.browser.onState((event) => {
      if (event.conversationId === conversationId) setState(event.state);
    });
  }, [conversationId]);

  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [state.url, editing]);

  useEffect(() => {
    const title = state.title.trim() || t('Browser');
    panelApi.setTitle(title);
  }, [panelApi, state.title, t]);

  useEffect(() => {
    let raf = 0;
    let disposed = false;
    const tick = () => {
      if (disposed) return;
      const el = hostRef.current;
      let rect: Rect | null = null;
      if (
        el &&
        sidebarOpen &&
        isActiveConversation &&
        panelApi.isActive &&
        panelApi.isVisible &&
        document.visibilityState === 'visible'
      ) {
        const box = el.getBoundingClientRect();
        if (box.width >= 1 && box.height >= 1 && el.isConnected) {
          rect = {
            x: Math.round(box.left),
            y: Math.round(box.top),
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        }
      }
      if (lastSent.current === undefined || !sameRect(lastSent.current, rect)) {
        lastSent.current = rect;
        void window.electronAPI.browser.setViewport(conversationId, rect).then(setState);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      // 卸载 / 关面板：隐藏 view，但不销毁 tab（页继续无头存活）
      if (lastSent.current !== null) {
        lastSent.current = null;
        void window.electronAPI.browser.setViewport(conversationId, null);
      }
    };
  }, [conversationId, panelApi, sidebarOpen, isActiveConversation]);

  const submit = async () => {
    setEditing(false);
    const target = address.trim();
    if (!target) return;
    const result = await window.electronAPI.browser.navigate(conversationId, target);
    setError(result.ok ? null : (result.error ?? t('Navigation failed')));
  };

  const iconButton =
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b bg-background px-2 py-1">
        <button
          type="button"
          className={iconButton}
          disabled={!state.canGoBack}
          onClick={() => void window.electronAPI.browser.goBack(conversationId)}
          aria-label={t('Back')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={!state.canGoForward}
          onClick={() => void window.electronAPI.browser.goForward(conversationId)}
          aria-label={t('Forward')}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={!state.tabId}
          onClick={() => void window.electronAPI.browser.reload(conversationId)}
          aria-label={t('Reload')}
        >
          <RotateCw className={cn('h-3.5 w-3.5', state.loading && 'animate-spin')} />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs focus-within:border-ring"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setEditing(true);
              e.target.select();
            }}
            onBlur={() => setEditing(false)}
            placeholder={t('Enter a URL')}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </form>
        {state.locked && (
          <button
            type="button"
            className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
            onClick={() => void window.electronAPI.browser.setLocked(conversationId, false)}
          >
            <Hand className="h-3 w-3" />
            {t('Take control')}
          </button>
        )}
      </div>
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-1 text-xs text-destructive">{error}</div>
      )}
      <div
        ref={hostRef}
        className={cn(
          'relative min-h-0 flex-1',
          state.tabId ? 'bg-transparent' : 'bg-background'
        )}
      >
        {!state.tabId && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <Globe className="h-6 w-6 opacity-40" />
            <p>{t('Enter a URL above, or let the agent open a page with browser_navigate.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
