import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useSessionsStore } from '@/stores/sessions';
import { useSidePanelStore } from '@/stores/sidePanel';

/**
 * 侧栏面板此刻是否在屏幕上。dock 按会话常驻（mountedIds 只增不减），隐藏会话里的面板照常挂载，
 * window 级快捷键和定时轮询必须先问这里，不能只看窗口是否聚焦。
 */

/** dockview 面板 api 里判定可见性用到的最小子集 */
export interface PanelActivitySource {
  readonly isActive: boolean;
  readonly isVisible: boolean;
  readonly onDidActiveChange: (listener: () => void) => { dispose(): void };
  readonly onDidVisibilityChange: (listener: () => void) => { dispose(): void };
}

export interface PanelVisibility {
  /** 正显示在屏幕上：所在 dock 属于当前会话且侧栏展开，tab 在其分组里被选中 */
  visible: boolean;
  /** 所在分组是激活分组（Cmd+W 会关掉的那个面板）。快捷键见 usePanelHotkeyTarget */
  active: boolean;
}

/** 不在侧栏 dock 里（如 Bot 面板）时没有 dock 层的隐藏，按可见且激活处理 */
const PanelVisibilityContext = createContext<PanelVisibility>({ visible: true, active: true });

export function PanelVisibilityProvider({
  dockConversationId,
  api,
  children,
}: {
  dockConversationId: string;
  api: PanelActivitySource;
  children: ReactNode;
}) {
  // 与 SidePanel 隐藏 dock 的口径一致：非当前会话的 dock 整块 hidden，侧栏收起则整体 invisible
  const current = useSessionsStore((s) => s.activeId === dockConversationId);
  const open = useSidePanelStore((s) => Boolean(s.uiByConversation[dockConversationId]?.open));
  const subscribe = useCallback(
    (onChange: () => void) => {
      const active = api.onDidActiveChange(onChange);
      const visibility = api.onDidVisibilityChange(onChange);
      return () => {
        active.dispose();
        visibility.dispose();
      };
    },
    [api]
  );
  // dockview 的 isVisible = tab 在分组里被选中且分组未被隐藏；isActive 还要求所在分组是激活分组
  const isActive = useSyncExternalStore(subscribe, () => api.isActive);
  const isVisible = useSyncExternalStore(subscribe, () => api.isVisible);
  const visible = current && open && isVisible;
  const value = useMemo(() => ({ visible, active: visible && isActive }), [visible, isActive]);
  return (
    <PanelVisibilityContext.Provider value={value}>{children}</PanelVisibilityContext.Provider>
  );
}

export function usePanelVisibility(): PanelVisibility {
  return useContext(PanelVisibilityContext);
}

export type PanelHotkeyKind = 'files' | 'browser';

interface HotkeyClaim {
  kind: PanelHotkeyKind;
  visible: boolean;
  active: boolean;
}

const hotkeyClaims = new Map<symbol, HotkeyClaim>();
const hotkeyListeners = new Set<() => void>();

function emitHotkeys(): void {
  for (const listener of hotkeyListeners) listener();
}

function subscribeHotkeys(listener: () => void): () => void {
  hotkeyListeners.add(listener);
  return () => {
    hotkeyListeners.delete(listener);
  };
}

function hotkeyOwned(id: symbol): boolean {
  const self = hotkeyClaims.get(id);
  if (!self?.visible) return false;
  let visiblePeers = 0;
  let activeId: symbol | undefined;
  for (const [peerId, peer] of hotkeyClaims) {
    if (peer.kind !== self.kind || !peer.visible) continue;
    visiblePeers += 1;
    if (peer.active) activeId = peerId;
  }
  return visiblePeers <= 1 || activeId === id;
}

/**
 * 窗口级快捷键归谁。同一种面板只有一个可见时，它接管（分屏焦点在终端、或点了原生视图
 * 没把分组标成激活，也要能按 ⌘S / 标注键）。同时有多个可见时，只交给激活的那个。
 * `enabled=false`（宿主自己决定，如 Bot 面板）时不登记，免得把侧栏同类面板的计数凑多。
 */
export function usePanelHotkeyTarget(kind: PanelHotkeyKind, enabled = true): boolean {
  const { visible, active } = usePanelVisibility();
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol(kind);
  const id = idRef.current;
  useEffect(() => {
    if (!enabled) return;
    hotkeyClaims.set(id, { kind, visible, active });
    emitHotkeys();
    return () => {
      hotkeyClaims.delete(id);
      emitHotkeys();
    };
  }, [active, enabled, id, kind, visible]);
  const owned = useSyncExternalStore(subscribeHotkeys, () => hotkeyOwned(id));
  return enabled && owned;
}
