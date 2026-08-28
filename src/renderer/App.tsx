import { useCallback, useEffect, useState } from 'react';
import { SummonEnsoButton, TitleBar } from '@/components/app/TitleBar';
import { UpdateBanner } from '@/components/app/UpdateBanner';
import { ChatView } from '@/components/chat/ChatView';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { Sidebar } from '@/components/chat/Sidebar';
import { OauthCredentialBootstrap } from '@/components/oauth/OauthCredentialBootstrap';
import { Onboarding } from '@/components/onboarding/Onboarding';
import { effectiveKeybindings, eventToBinding } from '@/lib/keybindings';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

const WIDTH_KEY = 'enso-sidebar-width';
const COLLAPSED_KEY = 'enso-sidebar-collapsed';
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;

export default function App() {
  const onboarded = useSettingsStore((s) => s.onboarded);

  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : 280;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');

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

  return (
    <div className="flex h-screen flex-col">
      <OauthCredentialBootstrap />
      <TitleBar title="EnsoCode" actions={<SummonEnsoButton label={false} />} />
      <UpdateBanner />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          width={collapsed ? undefined : width}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
        {!collapsed && <ResizeHandle onResize={handleResize} />}
        <ChatView />
      </div>
      {!onboarded && <Onboarding />}
    </div>
  );
}
