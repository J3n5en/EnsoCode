/** 一个聊天的共享浏览器标签：成员（含委派子会话）与用户共用 */
export interface ChatBrowserTabs {
  tabs: string[];
  active: string;
}

export function revealChatTab(
  current: ChatBrowserTabs | undefined,
  tabId: string
): ChatBrowserTabs {
  const tabs = current?.tabs.includes(tabId) ? current.tabs : [...(current?.tabs ?? []), tabId];
  return { tabs, active: tabId };
}

export function closeChatTab(current: ChatBrowserTabs, tabId: string): ChatBrowserTabs | undefined {
  const index = current.tabs.indexOf(tabId);
  if (index < 0) return current;
  const tabs = current.tabs.filter((id) => id !== tabId);
  if (tabs.length === 0) return undefined;
  const active = current.active === tabId ? tabs[Math.min(index, tabs.length - 1)] : current.active;
  return { tabs, active };
}

export function parseChatTabs(raw: unknown): Record<string, ChatBrowserTabs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ChatBrowserTabs> = {};
  for (const [chatId, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[chatId] = { tabs: [value], active: value };
      continue;
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.tabs)) continue;
    const tabs = value.tabs.filter((id: unknown): id is string => typeof id === 'string');
    if (tabs.length === 0) continue;
    out[chatId] = { tabs, active: tabs.includes(value.active) ? value.active : tabs[0] };
  }
  return out;
}
