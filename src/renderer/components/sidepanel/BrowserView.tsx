import type { BrowserTabState } from '@shared/types/browser';
import type { DockviewPanelApi } from 'dockview-react';
import { ArrowLeft, ArrowRight, Bug, Globe, Hand, RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';
import { isCoveredBy, overlayBoxes } from './overlayCover';

const EMPTY: BrowserTabState = {
  tabId: null,
  url: '',
  title: '',
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  locked: false,
  devtoolsOpen: false,
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

const MIN_PANE = 80;
const DEFAULT_DEVTOOLS_RATIO = 0.42;

function readBox(el: HTMLElement | null): Rect | null {
  if (!el?.isConnected) return null;
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

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
  const [devtoolsRatio, setDevtoolsRatio] = useState(DEFAULT_DEVTOOLS_RATIO);
  const hostRef = useRef<HTMLDivElement>(null);
  const dtRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef<Rect | null | undefined>(undefined);
  const lastCovered = useRef(false);
  const lastDt = useRef<Rect | null | undefined>(undefined);
  const lastDtCovered = useRef(false);
  const lockedRef = useRef(false);
  lockedRef.current = state.locked;
  const devtoolsOpenRef = useRef(false);
  devtoolsOpenRef.current = state.devtoolsOpen;
  const tabId = panelApi.id;

  useEffect(() => {
    return window.electronAPI.browser.onState((event) => {
      if (event.tabId === tabId) setState(event.state);
    });
  }, [tabId]);

  useEffect(() => {
    if (!editing) setAddress(state.url);
  }, [state.url, editing]);

  useEffect(() => {
    const title = state.title.trim() || t('Browser');
    panelApi.setTitle(title);
    panelApi.updateParameters({ ...panelApi.getParameters(), favicon: state.favicon });
  }, [panelApi, state.title, state.favicon, t]);

  useEffect(() => {
    let raf = 0;
    let disposed = false;
    const root = document.getElementById('root');
    const tick = () => {
      if (disposed) return;
      const visible =
        sidebarOpen &&
        isActiveConversation &&
        panelApi.isActive &&
        panelApi.isVisible &&
        document.visibilityState === 'visible';
      const rect = visible ? readBox(hostRef.current) : null;
      const covered =
        rect !== null && (lockedRef.current || isCoveredBy(rect, overlayBoxes(document, root)));
      if (
        lastSent.current === undefined ||
        !sameRect(lastSent.current, rect) ||
        covered !== lastCovered.current
      ) {
        lastSent.current = rect;
        lastCovered.current = covered;
        void window.electronAPI.browser
          .setViewport(tabId, conversationId, rect, covered)
          .then(setState);
      }
      const dtRect = visible && devtoolsOpenRef.current ? readBox(dtRef.current) : null;
      const dtCovered = dtRect !== null && isCoveredBy(dtRect, overlayBoxes(document, root));
      if (
        lastDt.current === undefined ||
        !sameRect(lastDt.current, dtRect) ||
        dtCovered !== lastDtCovered.current
      ) {
        lastDt.current = dtRect;
        lastDtCovered.current = dtCovered;
        void window.electronAPI.browser
          .setDevToolsViewport(tabId, conversationId, dtRect, dtCovered)
          .then(setState);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (lastSent.current !== null) {
        lastSent.current = null;
        void window.electronAPI.browser.setViewport(tabId, conversationId, null);
      }
      if (lastDt.current !== null) {
        lastDt.current = null;
        void window.electronAPI.browser.setDevToolsViewport(tabId, conversationId, null);
      }
    };
  }, [conversationId, tabId, panelApi, sidebarOpen, isActiveConversation]);

  const submit = async () => {
    setEditing(false);
    const target = address.trim();
    if (!target) return;
    const result = await window.electronAPI.browser.navigate(tabId, conversationId, target);
    setError(result.ok ? null : (result.error ?? t('Navigation failed')));
  };

  const onSplitPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    const dt = dtRef.current;
    if (!host || !dt) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHost = host.getBoundingClientRect().height;
    const startDt = dt.getBoundingClientRect().height;
    const total = startHost + startDt;
    const onMove = (move: globalThis.PointerEvent) => {
      const nextDt = Math.min(
        total - MIN_PANE,
        Math.max(MIN_PANE, startDt - (move.clientY - startY))
      );
      setDevtoolsRatio(nextDt / total);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const iconButton =
    'flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b bg-background px-2 py-1">
        <button
          type="button"
          className={iconButton}
          disabled={state.locked || !state.canGoBack}
          onClick={() => void window.electronAPI.browser.goBack(tabId)}
          aria-label={t('Back')}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={state.locked || !state.canGoForward}
          onClick={() => void window.electronAPI.browser.goForward(tabId)}
          aria-label={t('Forward')}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={iconButton}
          disabled={state.locked || !state.tabId}
          onClick={() => void window.electronAPI.browser.reload(tabId)}
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
            disabled={state.locked}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
        </form>
        <button
          type="button"
          className={cn(iconButton, state.devtoolsOpen && 'bg-muted text-foreground')}
          disabled={!state.tabId}
          onClick={() =>
            void window.electronAPI.browser.setDevTools(tabId, !state.devtoolsOpen).then(setState)
          }
          aria-label={t('Toggle Developer Tools')}
          aria-pressed={state.devtoolsOpen}
        >
          <Bug className="h-3.5 w-3.5" />
        </button>
        {state.locked && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
            <Hand className="h-3 w-3" />
            {t('Enso is in control')}
          </span>
        )}
      </div>
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-1 text-xs text-destructive">{error}</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={hostRef}
          className={cn(
            'relative min-h-0',
            state.devtoolsOpen ? 'shrink-0' : 'flex-1',
            state.url.startsWith('http') && !state.loading ? 'bg-transparent' : 'bg-background'
          )}
          style={state.devtoolsOpen ? { flex: `${1 - devtoolsRatio} 1 0` } : undefined}
        >
          {!state.url.startsWith('http') && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <Globe className="h-6 w-6 opacity-40" />
              <p>{t('Enter a URL above, or let the agent open a page with browser_navigate.')}</p>
            </div>
          )}
          {state.locked && (
            <div className="group absolute inset-0 z-10 flex cursor-default items-center justify-center">
              <div className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/40" />
              <button
                type="button"
                className="relative flex items-center gap-1.5 rounded-full border bg-background px-4 py-2 text-sm shadow-lg opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
                onClick={() => void window.electronAPI.browser.setLocked(conversationId, false)}
              >
                <Hand className="h-3.5 w-3.5" />
                {t('Take control')}
              </button>
            </div>
          )}
        </div>
        {state.devtoolsOpen && (
          <>
            <div
              ref={splitRef}
              className="h-1.5 shrink-0 cursor-row-resize bg-border hover:bg-ring"
              onPointerDown={onSplitPointer}
            />
            <div
              ref={dtRef}
              className="min-h-0 bg-transparent"
              style={{ flex: `${devtoolsRatio} 1 0` }}
            />
          </>
        )}
      </div>
    </div>
  );
}
