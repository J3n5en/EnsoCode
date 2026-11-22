import type { DockviewPanelApi } from 'dockview-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelShown, useSidePanelStore } from '@/stores/sidePanel';
import { pluginPanelId } from '@/stores/sidePanel/globalTabs';
import { PluginFrame } from '../../plugins/PluginView';
import { usePluginViews } from '../../plugins/viewBridge';

/**
 * 全局插件页面的常驻层：每个全局页面只建一个 iframe，叠到当前会话 dock 里同 id 面板的占位块上。
 * iframe 一旦移出文档就会重载，所以换会话、收起侧栏、没有占位时只用 visibility 藏起来，从不卸载。
 */

interface Slot {
  panelId: string;
  conversationId: string;
  el: HTMLElement;
  api: Pick<DockviewPanelApi, 'isVisible' | 'setActive'>;
}

const slots = new Set<Slot>();
const slotListeners = new Set<() => void>();

function notifySlots(): void {
  for (const listener of slotListeners) listener();
}

/** dock 里全局面板的占位块：只上报自己的位置，内容由常驻层画 */
export function GlobalPluginSlot({
  panelId,
  conversationId,
  api,
  containerApi,
}: {
  panelId: string;
  conversationId: string;
  api: DockviewPanelApi;
  containerApi: { onDidLayoutChange: (listener: () => void) => { dispose(): void } };
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const slot: Slot = { panelId, conversationId, el, api };
    slots.add(slot);
    notifySlots();
    const ro = new ResizeObserver(notifySlots);
    ro.observe(el);
    const subs = [
      api.onDidVisibilityChange(notifySlots),
      api.onDidActiveChange(notifySlots),
      api.onDidDimensionsChange(notifySlots),
      containerApi.onDidLayoutChange(notifySlots),
    ];
    return () => {
      slots.delete(slot);
      ro.disconnect();
      for (const sub of subs) sub.dispose();
      notifySlots();
    };
  }, [panelId, conversationId, api, containerApi]);
  return <div ref={ref} data-global-plugin-slot={panelId} className="h-full w-full" />;
}

type Rect = { left: number; top: number; width: number; height: number };

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.left === b.left &&
      a.top === b.top &&
      a.width === b.width &&
      a.height === b.height)
  );
}

function findSlot(panelId: string, conversationId: string | null): Slot | undefined {
  if (!conversationId) return undefined;
  for (const slot of slots) {
    if (slot.panelId !== panelId || slot.conversationId !== conversationId) continue;
    if (slot.el.isConnected && slot.api.isVisible) return slot;
  }
  return undefined;
}

export function GlobalPluginLayer() {
  const activeId = useSessionsStore((s) => s.activeId);
  const shown = useSidePanelShown(activeId);
  const liveTabs = useSidePanelStore((s) => s.liveGlobalTabs);
  const views = usePluginViews();
  const layerRef = useRef<HTMLDivElement>(null);
  /** 最近一次可见时的位置：藏起来时保持尺寸，免得插件页面跟着 0 宽重排 */
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  /**
   * 拖 dockview 标签时整层藏起来：插件页面的内层 iframe 是独立进程，dockview 给 iframe 加的
   * pointer-events:none 挡不住 HTML5 拖放，放置区域会被它吃掉。visibility 不会让 iframe 重载。
   */
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const start = (event: DragEvent) => {
      if (event.target instanceof Element && event.target.closest('.dv-dockview'))
        setDragging(true);
    };
    const end = () => setDragging(false);
    document.addEventListener('dragstart', start, true);
    document.addEventListener('dragend', end, true);
    document.addEventListener('drop', end, true);
    return () => {
      document.removeEventListener('dragstart', start, true);
      document.removeEventListener('dragend', end, true);
      document.removeEventListener('drop', end, true);
    };
  }, []);

  const measure = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const box = layer.getBoundingClientRect();
    const found: Record<string, Rect | null> = {};
    for (const panelId of liveTabs) {
      const slot = shown ? findSlot(panelId, activeId) : undefined;
      const r = slot?.el.getBoundingClientRect();
      found[panelId] =
        r && r.width > 0 && r.height > 0
          ? { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height }
          : null;
    }
    setRects((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [panelId, rect] of Object.entries(found)) {
        if (rect && !sameRect(prev[panelId], rect)) {
          next[panelId] = rect;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    const nextVisible = Object.fromEntries(
      Object.entries(found).map(([panelId, rect]) => [panelId, rect !== null])
    );
    setVisible((prev) => {
      const keys = new Set([...Object.keys(prev), ...Object.keys(nextVisible)]);
      for (const key of keys) if (prev[key] !== nextVisible[key]) return nextVisible;
      return prev;
    });
  }, [activeId, liveTabs, shown]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    slotListeners.add(schedule);
    const ro = new ResizeObserver(schedule);
    if (layerRef.current) ro.observe(layerRef.current);
    window.addEventListener('resize', schedule);
    // 点进 iframe 不会冒泡到 dockview：窗口失焦且焦点落在常驻层时，把对应面板设为激活
    const onBlur = () => {
      const focused = document.activeElement;
      if (!focused || !layerRef.current?.contains(focused)) return;
      const panelId = focused.closest<HTMLElement>('[data-global-plugin]')?.dataset.globalPlugin;
      if (panelId) findSlot(panelId, useSessionsStore.getState().activeId)?.api.setActive();
    };
    window.addEventListener('blur', onBlur);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      slotListeners.delete(schedule);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('blur', onBlur);
    };
  }, [measure]);

  return (
    <div ref={layerRef} className="enso-global-plugin-layer pointer-events-none absolute inset-0">
      {liveTabs.map((panelId) => {
        const view = views.find((entry) => pluginPanelId(entry) === panelId);
        if (!view) return null;
        const rect = rects[panelId];
        const style: CSSProperties = {
          position: 'absolute',
          left: rect?.left ?? 0,
          top: rect?.top ?? 0,
          width: rect?.width ?? '100%',
          height: rect?.height ?? '100%',
          visibility: visible[panelId] && !dragging ? 'visible' : 'hidden',
        };
        return (
          <div key={panelId} data-global-plugin={panelId} style={style}>
            <PluginFrame
              pluginId={view.pluginId}
              entry={view.entry}
              title={view.title}
              sessionId={activeId}
            />
          </div>
        );
      })}
    </div>
  );
}
