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
import { ChatView } from '@/components/chat/ChatView';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { Sidebar } from '@/components/chat/Sidebar';
import { OauthCredentialBootstrap } from '@/components/oauth/OauthCredentialBootstrap';
import { Onboarding } from '@/components/onboarding/Onboarding';
import { SidePanel } from '@/components/sidepanel/SidePanel';
import { ToastProvider } from '@/components/ui/toast';
import { useBackgroundImage } from '@/hooks/useBackgroundImage';
import { useI18n } from '@/i18n';
import { effectiveKeybindings, eventToBinding } from '@/lib/keybindings';
import { cn } from '@/lib/utils';
import { bindPairCatalogSync } from '@/stores/pairCatalog';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useSidePanelStore } from '@/stores/sidePanel';

/** 碰撞策略:光标所在的落点优先(否则会话行的大矩形会把置顶条/输入框让给重叠面积更大的项目块) */
const dndCollision: CollisionDetection = (args) => {
  const withPointer = pointerWithin(args);
  return withPointer.length > 0 ? withPointer : rectIntersection(args);
};

const WIDTH_KEY = 'enso-sidebar-width';
const COLLAPSED_KEY = 'enso-sidebar-collapsed';
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const SIDE_WIDTH_KEY = 'enso-side-panel-width';
const SIDE_MIN_WIDTH = 280;
const SIDE_MAX_WIDTH = 800;

export default function App() {
  const onboarded = useSettingsStore((s) => s.onboarded);
  useBackgroundImage();
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : 280;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const { t } = useI18n();
  const sideOpen = useSidePanelStore((s) => s.open);
  const toggleSidePanel = useSidePanelStore((s) => s.toggleOpen);
  const [sideWidth, setSideWidth] = useState(() => {
    const saved = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= SIDE_MIN_WIDTH
      ? Math.min(saved, SIDE_MAX_WIDTH)
      : 360;
  });
  useEffect(() => {
    localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth));
  }, [sideWidth]);
  // 右侧面板:手柄在面板左缘,向左拖加宽
  const handleSideResize = useCallback((deltaX: number) => {
    setSideWidth((w) => Math.min(SIDE_MAX_WIDTH, Math.max(SIDE_MIN_WIDTH, w - deltaX)));
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
        useSessionsStore.getState().prefillAgent(prefill.typeKey);
      }),
    []
  );

  // 手机第二屏：会话目录/项目/provider 只在 renderer，绑定后 debounce 同步给 main
  useEffect(() => {
    bindPairCatalogSync();
  }, []);

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
    const onKeyDown = (e: KeyboardEvent) => {
      const pressed = eventToBinding(e);
      if (!pressed) return;
      if (pressed === bindings['toggle-sidebar']) {
        e.preventDefault();
        setCollapsed((v) => !v);
      } else if (pressed === bindings['open-settings']) {
        e.preventDefault();
        void window.electronAPI.window.openSettings();
      } else if (pressed === bindings['new-conversation']) {
        e.preventDefault();
        const sessions = useSessionsStore.getState();
        const active = sessions.activeId ? sessions.conversations[sessions.activeId] : null;
        const projectId = active?.projectId ?? useSettingsStore.getState().projects[0]?.id;
        if (projectId) void sessions.newConversation(projectId);
      } else if (pressed === bindings['next-tab']) {
        e.preventDefault();
        cycleTab(1);
      } else if (pressed === bindings['prev-tab']) {
        e.preventDefault();
        cycleTab(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keybindings]);

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
        }
      />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <DndContext sensors={dndSensors} collisionDetection={dndCollision}>
          <Sidebar
            width={collapsed ? undefined : width}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((v) => !v)}
          />
          {!collapsed && <ResizeHandle onResize={handleResize} />}
          <ChatView />
          {sideOpen && <ResizeHandle onResize={handleSideResize} />}
          <SidePanel width={sideWidth} />
        </DndContext>
      </div>
      {!onboarded && <Onboarding />}
    </div>
  );
}
