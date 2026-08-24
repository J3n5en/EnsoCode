import { useCallback, useEffect, useState } from 'react';
import { TitleBar } from '@/components/app/TitleBar';
import { ChatView } from '@/components/chat/ChatView';
import { ResizeHandle } from '@/components/chat/ResizeHandle';
import { Sidebar } from '@/components/chat/Sidebar';

const WIDTH_KEY = 'enso-sidebar-width';
const COLLAPSED_KEY = 'enso-sidebar-collapsed';
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;

export default function App() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : 240;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width));
  }, [width]);
  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const handleResize = useCallback((deltaX: number) => {
    setWidth((w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + deltaX)));
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <TitleBar title="EnsoCode" />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          width={collapsed ? undefined : width}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
        {!collapsed && <ResizeHandle onResize={handleResize} />}
        <ChatView />
      </div>
    </div>
  );
}
