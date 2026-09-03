import {
  type CollisionDetection,
  DndContext,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { PanelRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BackgroundLayer } from '@/components/app/BackgroundLayer';
import { TitleBar } from '@/components/app/TitleBar';
import { UpdateBanner } from '@/components/app/UpdateBanner';
import { requestOpenChatFind } from '@/components/chat/ChatFindBar';
import { ChatView } from '@/components/chat/ChatView';
import { requestFocusComposer } from '@/components/chat/composerMentionBridge';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { Sidebar } from '@/components/chat/Sidebar';
import { RemoteNodeView } from '@/components/nodes/RemoteNodeView';
import { OauthCredentialBootstrap } from '@/components/oauth/OauthCredentialBootstrap';
import { Onboarding } from '@/components/onboarding/Onboarding';
import { WorkspaceSearchDialog } from '@/components/search/WorkspaceSearchDialog';
import { SidePanel } from '@/components/sidepanel/SidePanel';
import { ToastProvider } from '@/components/ui/toast';
import { useBackgroundImage } from '@/hooks/useBackgroundImage';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, eventToBinding, isEventInSidePanel } from '@/lib/keybindings';
import { addSidePanelTerminal, closeActiveSidePanelTab } from '@/lib/sidePanelDock';
import { cn } from '@/lib/utils';
import { bindPairCatalogSync } from '@/stores/pairCatalog';
import { useRemoteNodesStore } from '@/stores/remoteNodes';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { SIDE_PANEL_DEFAULT_WIDTH, useSidePanelStore } from '@/stores/sidePanel';

/** 碰撞策略:光标所在的落点优先(否则会话行的大矩形会把置顶条/输入框让给重叠面积更大的项目块) */
const dndCollision: CollisionDetection = (args) => {
  const withPointer = pointerWithin(args);
  return withPointer.length > 0 ? withPointer : rectIntersection(args);
};

const WIDTH_KEY = 'enso-sidebar-width';
const COLLAPSED_KEY = 'enso-sidebar-collapsed';
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;

export default function App() {
  const onboarded = useSettingsStore((s) => s.onboarded);
  useBackgroundImage();
  const [searchOpen, setSearchOpen] = useState(false);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : 280;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const { t } = useI18n();
  const activeConversationId = useSessionsStore((s) => s.activeId);
  const sideOpen = useSidePanelStore((s) =>
    activeConversationId ? Boolean(s.uiByConversation[activeConversationId]?.open) : false
  );
  const sideWidth = useSidePanelStore(
    (s) => s.uiByConversation[activeConversationId ?? '']?.width ?? SIDE_PANEL_DEFAULT_WIDTH
  );
  const sideFullscreen = useSidePanelStore((s) => s.fullscreen);
  const toggleSidePanel = useSidePanelStore((s) => s.toggleOpen);
  useEffect(() => {
    if (sideFullscreen && !sideOpen) useSidePanelStore.getState().setFullscreen(false);
  }, [sideOpen, sideFullscreen]);
  useEffect(() => {
    document.documentElement.classList.add('enso-main-shell');
    return () => document.documentElement.classList.remove('enso-main-shell');
  }, []);
  // 右侧面板:手柄在面板左缘,向左拖加宽;拖拽中暂停宽度 spring 动画防抖动
  const [sideResizing, setSideResizing] = useState(false);
  const handleSideResize = useCallback((deltaX: number) => {
    useSidePanelStore.getState().nudgeWidth(-deltaX);
  }, []);

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(
    () =>
      window.electronAPI.window.onAgentComposerPrefill((prefill) => {
        useSessionsStore.getState().prefillAgent(prefill.typeKey, prefill.prompt);
      }),
    []
  );

  // 手机第二屏：会话目录/项目/provider 只在 renderer，绑定后 debounce 同步给 main
  useEffect(() => {
    bindPairCatalogSync();
  }, []);

  // 连接到节点：订阅 main 推的节点状态与对方下行帧
  useEffect(() => useRemoteNodesStore.getState().bind(), []);
  const activeNodeId = useRemoteNodesStore((s) => s.activeNodeId);
  const remoteNodeActive = activeNodeId !== 'local';

  const handleResize = useCallback((deltaX: number) => {
    setWidth((w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + deltaX)));
  }, []);

  // 全局快捷键(可在设置中改绑):折叠侧栏 / 打开设置 / 新对话 / coworker 标签切换
  const keybindings = useSettingsStore((s) => s.keybindings);
  useEffect(() => {
    const bindings = effectiveKeybindings(keybindings);
    // 主会话 + coworker 循环切换;无 coworker 时不动
    const cycleTab = (direction: 1 | -1) => {
      const sessions = useSessionsStore.getState();
      const parent = sessions.activeId ? sessions.conversations[sessions.activeId] : null;
      if (!parent) return;
      const tabs: (string | undefined)[] = [undefined, ...(parent.coworkerIds ?? [])];
      if (tabs.length <= 1) return;
      // activeTabId 指向已删 coworker 时 indexOf = -1,+1 后回落主会话
      const current = tabs.indexOf(parent.activeTabId);
      sessions.selectTab(parent.id, tabs[(current + direction + tabs.length) % tabs.length]);
    };
    const startNewConversation = () => {
      const sessions = useSessionsStore.getState();
      const active = sessions.activeId ? sessions.conversations[sessions.activeId] : null;
      const projectId = active?.projectId ?? useSettingsStore.getState().projects[0]?.id;
      if (projectId) void sessions.newConversation(projectId);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const pressed = eventToBinding(e);
      if (!pressed) return;
      // 远程节点态：本机会话相关的快捷键不响应（新对话/tab 切换/右侧面板/查找）
      const remote = useRemoteNodesStore.getState().activeNodeId !== 'local';
      if (
        remote &&
        [
          'new-conversation',
          'next-tab',
          'prev-tab',
          'toggle-side-panel',
          'toggle-side-panel-fullscreen',
          'new-side-tab',
          'close-side-tab',
          'find-in-chat',
          'search-workspace',
        ].some((key) => pressed === bindings[key as keyof typeof bindings])
      ) {
        return;
      }
      if (pressed === bindings['toggle-sidebar']) {
        e.preventDefault();
        setCollapsed((v) => !v);
      } else if (pressed === bindings['open-settings']) {
        e.preventDefault();
        void window.electronAPI.window.openSettings();
      } else if (pressed === bindings['new-conversation']) {
        e.preventDefault();
        startNewConversation();
      } else if (pressed === bindings['new-side-tab']) {
        e.preventDefault();
        if (isEventInSidePanel(e.target)) addSidePanelTerminal();
        else startNewConversation();
      } else if (pressed === bindings['next-tab']) {
        e.preventDefault();
        cycleTab(1);
      } else if (pressed === bindings['prev-tab']) {
        e.preventDefault();
        cycleTab(-1);
      } else if (pressed === bindings['toggle-side-panel']) {
        e.preventDefault();
        useSidePanelStore.getState().toggleOpen();
      } else if (pressed === bindings['toggle-side-panel-fullscreen']) {
        e.preventDefault();
        useSidePanelStore.getState().toggleFullscreen();
      } else if (pressed === bindings['close-side-tab']) {
        e.preventDefault();
        closeActiveSidePanelTab();
      } else if (pressed === bindings['focus-composer']) {
        e.preventDefault();
        requestFocusComposer();
      } else if (pressed === bindings['find-in-chat']) {
        e.preventDefault();
        requestOpenChatFind();
      } else if (pressed === bindings['search-workspace']) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keybindings]);

  useEffect(() => {
    if (!sideOpen || !sideFullscreen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (useRemoteNodesStore.getState().activeNodeId !== 'local') return;
      e.preventDefault();
      useSidePanelStore.getState().setFullscreen(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [sideOpen, sideFullscreen]);

  // 拖拽：侧栏项目排序 / 会话拖入 Composer / 拖到 Pinned 区。
  // 6px 启动阈值：行点击与行内按钮不受影响。onDragEnd 在 Sidebar 的 useDndMonitor 里。
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  return (
    <div className="relative isolate flex h-screen flex-col">
      {/* 全局 toast 出口（addToast 依赖；不挂则静默失效） */}
      <ToastProvider />
      <BackgroundLayer />
      <OauthCredentialBootstrap />
      <TitleBar
        title="EnsoCode"
        actions={
          // 远程节点态没有右侧面板，隐藏开关避免死按钮
          remoteNodeActive ? undefined : (
            <button
              type="button"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-accent/50',
                sideOpen ? 'text-foreground' : 'text-muted-foreground'
              )}
              onClick={toggleSidePanel}
              aria-label={t('Toggle side panel')}
              title={t('Toggle side panel')}
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )
        }
      />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        {remoteNodeActive ? (
          // 远程节点态：整块换成对方的目录与会话；本机 Sidebar/ChatView/SidePanel 卸载
          <RemoteNodeView nodeId={activeNodeId} sidebarWidth={width} />
        ) : (
          <DndContext sensors={dndSensors} collisionDetection={dndCollision}>
            <Sidebar
              width={collapsed ? undefined : width}
              collapsed={collapsed}
              onToggleCollapse={() => setCollapsed((v) => !v)}
              onOpenSearch={() => setSearchOpen(true)}
            />
            {!collapsed && <ResizeHandle onResize={handleResize} />}
            <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <ChatView />
              </div>
              {sideOpen && !sideFullscreen && (
                <ResizeHandle onResize={handleSideResize} onResizingChange={setSideResizing} />
              )}
              <SidePanel width={sideWidth} resizing={sideResizing} />
            </div>
          </DndContext>
        )}
      </div>
      {!onboarded && <Onboarding />}
      <WorkspaceSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
