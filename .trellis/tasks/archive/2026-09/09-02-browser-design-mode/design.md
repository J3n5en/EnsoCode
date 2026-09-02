# Design Mode 技术设计

## 边界

```
BrowserView 开关
    │  IPC setDesignMode(tabId, on)
    ▼
browserHost
    │  executeJavaScript(picker IIFE)
    │  Runtime.addBinding('ensoDesignMode')
    ▼
guest top frame overlay
    │  binding: hovered / picked / cancelled
    ▼
browserHost
    │  hide overlay → CDP clip 截图 → disable picker
    │  IPC event design-mode-picked
    ▼
renderer: insertUiElementMention(payload, image)
    ▼
Composer MentionSegment + bound image
    ▼
serializeSegments → user message text + images
```

guest **不加 preload**。页内不能 `window.cursorBrowser`。用 Chromium `Runtime.addBinding`（host 已有 debugger）把 JSON 字符串送回 Main。绑定名建议 `ensoDesignMode`。

Design Mode 不是 `BrowserOp`，不进 agent 工具表。

## 模块

| 层 | 文件（建议） | 职责 |
|---|---|---|
| shared | `src/shared/browser/designMode.ts` | 引用行 serialize/parse、payload 收窄、字段上限 |
| shared | `src/shared/browser/pageScripts.ts` | picker IIFE 源码（与 snapshot/lock overlay 并列） |
| shared | `src/shared/types/mentions.ts` | `UiElementMentionCandidate` |
| shared | `src/shared/types/ipc.ts` | `BROWSER_SET_DESIGN_MODE` / `BROWSER_DESIGN_MODE_EVENT` |
| main | `browserHost.ts` | 开关、binding、hide+screenshot、与 lock/devtools 互斥 |
| main | `ipc/browser.ts` | handler + 向窗口推事件 |
| preload | `electronAPI.browser.setDesignMode` / `onDesignMode` | 三点式链路 |
| renderer | `composerMentionBridge` | `insertUiElementMention` |
| renderer | `mentionComposer.ts` / MentionEditor / chip UI | 段模型、展开、点开预览 |
| renderer | `BrowserView.tsx` | 工具栏按钮、Esc |

## 页内 picker

`window.__ensoDesignModeInjected` 只在 `window === window.top` 装一次。之后开关只改内部 `enabled`。

- overlay 根节点固定 id（如 `enso-design-mode-root`），`pointer-events: none` 画框；指针事件在 document 捕获阶段拦下，`preventDefault`。
- 元素 id：`WeakMap<Element, string>`，禁止 `data-*`。
- hover 合帧（rAF），不必每像素回 host。
- 单击：`buildPayload` → binding `picked`。Esc / 开关关：binding `cancelled` 或 host 直接 disable。
- hide：截图前把 overlay `visibility:hidden`，截完再卸。

`buildPayload`（页内，已截断）：

```
label, path, text, tag, id, className, rect{x,y,width,height}, component?
```

`path` 用稳定 css-ish（`tag:nth-of-type` + id），不是 snapshot `ref`。

## Host 协议

`setDesignMode(tabId, enabled)`：

- `enabled=true`：`locked` 或 `devtoolsOpen` → 拒绝，状态不变。
- 注入/enable picker；`tab.designMode = true`；推 `BrowserTabState`。
- `enabled=false`：disable + 卸 overlay；`designMode=false`。

picked 处理（单飞，忽略过期 requestId）：

1. hide overlay
2. 用 payload.rect 做 CDP clip（与现有 `screenshot` 同路径；rect 非法则退回视口）
3. disable design mode
4. 向 renderer 推 `{ tabId, conversationId, payload, image }`

导航 / reload：`did-navigate` / `did-finish-load` 若 `designMode` 仍开，重新 enable（脚本随文档消失）。关 tab 只卸状态。

与 lock：`setLocked(true)` 必须先 `setDesignMode(false)`。开 Design Mode 不得铺 lock overlay。

与 DevTools：`assertDevtoolsIdle` 已挡 CDP；开关 UI 同步 disabled。

## Composer 协议

```ts
interface UiElementMentionCandidate {
  kind: 'ui-element';
  id: string;          // 本地 uuid
  label: string;       // chip 上显示
  path: string;
  text: string;
  imageId: string;     // 对应 images[] 条目
}

type MentionSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string }
  | { type: 'chat'; label: string; sessionFile: string }
  | { type: 'ui-element'; id: string; label: string; path: string; text: string; imageId: string };
```

wire 行（发送与回放同一正则）：

```
[Selected UI element "LABEL" — path: PATH; text: TEXT]
```

净化：LABEL/PATH/TEXT 去掉 `"[]\n`，空白折叠。超上限截断。`mentionDisplayText` 把该行折成 `@LABEL`，避免污染会话标题。

`createEditorPayload`：ui-element 段展开进 `text`，**不**进 `fileMentions`。`images` 仍是数组；绑定时 chip.imageId === 插入时分配的 id，Composer 用 `Map<imageId, AttachedImage>` 或给 `AttachedImage` 加可选 `id`（跨进程已有 `{data,mimeType}`——**发送给 agent 仍只发 data/mimeType**，id 仅编辑器生命周期）。

历史消息：`splitInlineMentions` 还原 ui-element 段。没有 imageId 的旧文本只出文字 chip，popover 无图。

`@` picker / `useMentionSearch`：**不**加入 ui-element。`parseMentionCandidate` 接受该 kind，便于测试与将来 IPC；`insertComposerMention` 类型扩到包含它，或单独 `insertUiElementMention`。

点 chip：popover 展示 `images[imageId]`。删段时按 imageId 从 images 移除。

## 互斥与失败

| 条件 | 行为 |
|---|---|
| lock | 按钮 disabled；host 拒绝 enable |
| DevTools 开 | 同上（截图通道被占） |
| 截图空 | 仍插入 chip，无绑定图；不静默丢选区 |
| 非 top / 跨域 iframe | 只选顶层；点到 iframe 表面则选 iframe 节点本身 |
| 无 Composer 注册 | host 仍关模式；renderer 丢掉本次 pick 并 toast（i18n） |

## 测试

必须单测（TDD）：

- `designMode.ts`：serialize ↔ parse、脏输入、净化、上限
- `mentions.ts`：`parseMentionCandidate` ui-element
- `mentionComposer.ts`：段展开 / `splitInlineMentions` / `mentionDisplayText` / 删段丢图的纯函数（把「按 imageId 滤 images」抽出来测）

不强制：BrowserView、注入脚本在真页里的命中（CDP 真机）。

## 回滚

删 IPC 两通道、host `designMode` 字段、picker 脚本、mention kind、工具栏按钮。不碰 `browser_*` 工具语义。
