/** 右侧 Tab 面板布局的纯 reducer：按会话隔离的 tab 集合与激活项 */

import type { SidePanelTab } from '@shared/types/sidePanel';

export interface SidePanelLayout {
  /** conversationId -> 该会话的 tab 列表（有序） */
  tabs: Record<string, SidePanelTab[]>;
  /** conversationId -> 激活 tab id */
  active: Record<string, string | undefined>;
}

export const emptyLayout = (): SidePanelLayout => ({ tabs: {}, active: {} });

export function addTab(
  layout: SidePanelLayout,
  conversationId: string,
  tab: SidePanelTab
): SidePanelLayout {
  const list = layout.tabs[conversationId] ?? [];
  return {
    tabs: { ...layout.tabs, [conversationId]: [...list, tab] },
    active: { ...layout.active, [conversationId]: tab.id },
  };
}

export function closeTab(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string
): SidePanelLayout {
  const list = layout.tabs[conversationId];
  if (!list) return layout;
  const index = list.findIndex((t) => t.id === tabId);
  if (index < 0) return layout;
  const next = list.filter((t) => t.id !== tabId);
  let active = layout.active[conversationId];
  if (active === tabId) {
    // 激活项被关：回落右邻，无右邻回落左邻，空则清除
    active = (next[index] ?? next[index - 1])?.id;
  }
  return {
    tabs: { ...layout.tabs, [conversationId]: next },
    active: { ...layout.active, [conversationId]: active },
  };
}

export function selectTab(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string
): SidePanelLayout {
  const list = layout.tabs[conversationId];
  if (!list?.some((t) => t.id === tabId)) return layout;
  return { ...layout, active: { ...layout.active, [conversationId]: tabId } };
}

export function moveTab(
  layout: SidePanelLayout,
  conversationId: string,
  activeId: string,
  overId: string
): SidePanelLayout {
  const list = layout.tabs[conversationId];
  if (!list || activeId === overId) return layout;
  const from = list.findIndex((t) => t.id === activeId);
  const to = list.findIndex((t) => t.id === overId);
  if (from < 0 || to < 0) return layout;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { ...layout, tabs: { ...layout.tabs, [conversationId]: next } };
}
