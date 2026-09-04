# Search Anything — 设计

## 行为差距

`mod+k` 只搜会话。应在同一 Command Dialog 里再搜浏览器标签和设置行，并深链跳转。

## 边界

- **会话检索**：沿用 `src/shared/workspaceSearch.ts` + 现有冷索引 IPC，不改排序契约。
- **浏览器列表**：Main `browserHost` 合并 live + persist，新 IPC 只出摘要，不收路径。
- **设置目录**：shared 静态目录 + 从 settings snapshot 投影具名条目；匹配纯函数无 React。
- **设置深链**：`WINDOW_OPEN_SETTINGS` 带可选 `{ category, rowId }`；设置窗切分类、滚到 `[data-settings-row]`、闪几下。
- **UI**：演进 `WorkspaceSearchDialog`，有查询时三组，空查询加最近标签。

## 数据流

```
mod+k → Dialog
  空：recent conversations + recent browser(3–5) + actions
  有查询：
    Conversations = 热 searchWorkspace ∪ 冷 workspaceSearch.query
    Browser      = electronAPI.browser.listSearchableTabs() → match title/url
    Settings     = catalog(settings snapshot) → match title/description/name
  选中：
    conversation → selectConversation / selectTab / 可选 ChatFindBar
    browser      → selectConversation + addSidePanelBrowser({ conversationId, tabId })
    settings     → window.openSettings({ category, rowId })
```

## 合同

```ts
type SearchAnythingKind = 'conversation' | 'browser' | 'settings';

interface BrowserSearchTab {
  tabId: string;
  conversationId: string;
  title: string;
  url: string;
  at: number;
  live: boolean;
}

interface SettingsSearchEntry {
  id: string;          // 稳定，如 'general.language' / 'providers.<providerId>'
  category: SettingsCategory;
  title: string;       // 已 i18n 或具名原文
  description?: string;
}

interface SettingsDeepLink {
  category: SettingsCategory;
  rowId: string;
}
```

浏览器合并：live 优先于同 `tabId` 的 persist；`at` 用 lastSeen / persist.at。只列 http(s) user 可见标签（与 persist 白名单一致）。IPC 无入参或只收空对象。

设置行：每个可搜块挂 `data-settings-row={id}`。闪烁用短 CSS（约 2–3 次，≤1.5s），不常驻高亮。设置窗已打开则 focus + 发深链，不新建第二窗。

匹配：复用 workspace-search 的 token 规则（CJK 子串、拉丁前缀、标点当分隔）。设置/浏览器组上限各 20，对话组仍 50。

## 兼容

- 快捷键名不改，capability 默认表不动。
- `openSettings()` 无参仍只打开/聚焦窗口。
- 不改 `mod+f`、不改会话冷索引请求形状。

## 明确不做

向量、搜源码/文件树/终端、设置内联改值、高亮后常驻、跨机搜索。
