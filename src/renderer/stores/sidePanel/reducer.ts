/** 右侧 Tab 面板布局的纯 reducer：按会话隔离,支持上(main)/下(split)两组分屏 */

import type { SidePanelTab } from '@shared/types/sidePanel';

export type SidePanelGroup = 'main' | 'split';

export interface SidePanelLayout {
  /** conversationId -> 主组 tab 列表（有序） */
  tabs: Record<string, SidePanelTab[]>;
  /** conversationId -> 主组激活 tab id */
  active: Record<string, string | undefined>;
  /** conversationId -> 下分屏组 tab 列表;缺席/空 = 未分屏 */
  splitTabs: Record<string, SidePanelTab[]>;
  /** conversationId -> 下分屏组激活 tab id */
  splitActive: Record<string, string | undefined>;
}

export const emptyLayout = (): SidePanelLayout => ({
  tabs: {},
  active: {},
  splitTabs: {},
  splitActive: {},
});

/** 组字段名映射,让增删改按组参数化 */
const FIELDS = {
  main: { list: 'tabs', act: 'active' },
  split: { list: 'splitTabs', act: 'splitActive' },
} as const;

/** tab 所在组;不存在返回 null */
export function groupOf(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string
): SidePanelGroup | null {
  if (layout.tabs[conversationId]?.some((t) => t.id === tabId)) return 'main';
  if (layout.splitTabs[conversationId]?.some((t) => t.id === tabId)) return 'split';
  return null;
}

/** 从组内移除 tab:激活项回落右邻→左邻;split 清空即取消分屏 */
function removeFromGroup(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string,
  group: SidePanelGroup
): SidePanelLayout {
  const { list, act } = FIELDS[group];
  const tabs = layout[list][conversationId] ?? [];
  const index = tabs.findIndex((t) => t.id === tabId);
  if (index < 0) return layout;
  const next = tabs.filter((t) => t.id !== tabId);
  let activeId = layout[act][conversationId];
  if (activeId === tabId) activeId = (next[index] ?? next[index - 1])?.id;
  return {
    ...layout,
    [list]: { ...layout[list], [conversationId]: next },
    [act]: { ...layout[act], [conversationId]: next.length > 0 ? activeId : undefined },
  };
}

/** 追加到组末尾并激活 */
function appendToGroup(
  layout: SidePanelLayout,
  conversationId: string,
  tab: SidePanelTab,
  group: SidePanelGroup
): SidePanelLayout {
  const { list, act } = FIELDS[group];
  const tabs = layout[list][conversationId] ?? [];
  return {
    ...layout,
    [list]: { ...layout[list], [conversationId]: [...tabs, tab] },
    [act]: { ...layout[act], [conversationId]: tab.id },
  };
}

export function addTab(
  layout: SidePanelLayout,
  conversationId: string,
  tab: SidePanelTab,
  group: SidePanelGroup = 'main'
): SidePanelLayout {
  return appendToGroup(layout, conversationId, tab, group);
}

export function closeTab(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string
): SidePanelLayout {
  const group = groupOf(layout, conversationId, tabId);
  if (!group) return layout;
  return removeFromGroup(layout, conversationId, tabId, group);
}

export function selectTab(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string
): SidePanelLayout {
  const group = groupOf(layout, conversationId, tabId);
  if (!group) return layout;
  const { act } = FIELDS[group];
  return { ...layout, [act]: { ...layout[act], [conversationId]: tabId } };
}

/** 拖到某个 tab 的位置:同组重排;跨组则插到目标 tab 之前 */
export function moveTab(
  layout: SidePanelLayout,
  conversationId: string,
  activeId: string,
  overId: string
): SidePanelLayout {
  if (activeId === overId) return layout;
  const fromGroup = groupOf(layout, conversationId, activeId);
  const toGroup = groupOf(layout, conversationId, overId);
  if (!fromGroup || !toGroup) return layout;

  if (fromGroup === toGroup) {
    const { list } = FIELDS[fromGroup];
    const tabs = layout[list][conversationId];
    const from = tabs.findIndex((t) => t.id === activeId);
    const to = tabs.findIndex((t) => t.id === overId);
    const next = [...tabs];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return { ...layout, [list]: { ...layout[list], [conversationId]: next } };
  }

  const moved = layout[FIELDS[fromGroup].list][conversationId].find((t) => t.id === activeId);
  if (!moved) return layout;
  let next = removeFromGroup(layout, conversationId, activeId, fromGroup);
  const { list, act } = FIELDS[toGroup];
  const targetTabs = [...(next[list][conversationId] ?? [])];
  const to = targetTabs.findIndex((t) => t.id === overId);
  targetTabs.splice(to < 0 ? targetTabs.length : to, 0, moved);
  next = {
    ...next,
    [list]: { ...next[list], [conversationId]: targetTabs },
    [act]: { ...next[act], [conversationId]: activeId },
  };
  return next;
}

/** 把 tab 移到目标组末尾并激活(拖入分屏区/拖回另一组);split 清空即取消分屏 */
export function moveTabToGroup(
  layout: SidePanelLayout,
  conversationId: string,
  tabId: string,
  group: SidePanelGroup
): SidePanelLayout {
  const fromGroup = groupOf(layout, conversationId, tabId);
  if (!fromGroup || fromGroup === group) return layout;
  const moved = layout[FIELDS[fromGroup].list][conversationId].find((t) => t.id === tabId);
  if (!moved) return layout;
  const next = removeFromGroup(layout, conversationId, tabId, fromGroup);
  return appendToGroup(next, conversationId, moved, group);
}
