# Browser Design Mode：圈选元素交给 Agent

## Goal

用户在右侧栏内嵌 Browser 打开 Design Mode，点一个「有意义」节点，得到可删的 Composer chip + 绑定截图，再在原输入框写意图发给当前会话 Agent。用来改 UI / 指问题。不新增 agent 浏览器工具，也不把选区变成可再点击的 snapshot `ref`。

## Background

父任务 `09-01-enso-in-app-browser`：网页由 Main `WebContentsView` 叠在 Browser 面板上；agent 用 `browser_*` + a11y `ref`。Design Mode 是另一条链：**人圈给模型看**。

Cursor 3.18 对标（本机 `workbench.glass.main.js`）：页内 picker IIFE、WeakMap 元素 id、`postMessage` / `cursorBrowser.send`、composer `uiElementSelections`。Enso 不复制那套 context 槽。

Enso 约束：

- Composer 只有 `text + images + mentions`。文件/会话 chip 发送时原位展开成 wire text；气泡用同一正则还原。
- guest tab **没有 preload**（`sandbox + contextIsolation + nodeIntegration: false`）。页内脚本不能 `ipcRenderer`。
- 截图已有 host 内 CDP `Page.captureScreenshot`；DevTools 打开时 CDP 被掐掉。
- lock overlay 吞用户指针；Design Mode 与 lock 互斥。
- 侧栏往 Composer 塞内容的桥：`composerMentionBridge`。图片目前是 Composer 本地 `images` 数组，没有「跟 mention 绑定」的 API。

## Requirements

- **R1 入口**：Browser 工具栏 DevTools 旁增加 Design Mode 开关（笔形）。开启时按钮按下、十字准星。不要第一刀快捷键。Esc 退出并卸 overlay。
- **R2 选区**：仅 top frame。hover 高亮；单击选「有意义」节点（button/a/input/ARIA 控件、有 `id`、有 onclick、组件边界优先；跳过 `html/script/style` 与纯装饰 svg/span）。元素身份用 WeakMap，不写 DOM 属性。
- **R3 闭环**：选中后立即关掉 Design Mode（按钮弹起、overlay 卸掉），向当前会话主 Composer 插入一枚 `ui-element` chip，并绑定一张藏 overlay 后的元素截图。用户在原输入框改字再发。
- **R4 chip**：
  - 不进 `@` 搜索 picker，只从 Design Mode 插入。
  - 发送原位展开为单行：`[Selected UI element "LABEL" — path: PATH; text: TEXT]`（LABEL/PATH/TEXT 已净化、有上限；与 chat 引用块同样发送/回放必须同步）。
  - 段带 `imageId`；截图在 `images` 里但跟 chip 绑定。删 chip 丢掉这张图，用户另贴的图不动。
  - 点击 chip 用 popover 预览绑定图（不新开窗口）。
  - 历史气泡能从 wire text 还原 chip；预览图依赖当时消息的 `images` 顺序/绑定，旧消息没有绑定则只显示文字 chip。
- **R5 互斥**：该 tab `locked` 或 DevTools 打开时不能进入 Design Mode。Design Mode 开着时用户指针归 picker，不走普通点击、不走 lock overlay。
- **R6 清理**：退出 / 导航 / reload / 关 tab / 切走面板时卸 picker 节点与监听，不把 overlay 留给宿主页。
- **R7 边界**：不新增 `browser_design_*` / 不把选区写成 snapshot `ref` / 不把任意 CDP 交给模型。模型只看见用户消息里的展开文本 + 图。

## Out of Scope

- 页内批注框、当场提交
- 涂鸦 / 冻结视口帧
- 多选色相、父/子/兄弟树导航、选区编组
- Canvas / 中央编辑器 Design Mode
- Toggle Design Mode 可配置快捷键
- HMR fingerprint 重绑（选完即退出，第一刀不做）
- React/Vue/Svelte props 全量序列化
- 改用户日常 Chrome

## Acceptance Criteria

- [ ] AC1：未 lock、DevTools 关着时，工具栏可打开 Design Mode；按钮 `aria-pressed=true`，页上十字准星 + hover 框。
- [ ] AC2：单击一个按钮/链接后 Design Mode 关闭，左侧 Composer 出现一枚可删 chip，并多一张绑定截图；截图里没有 picker 框。
- [ ] AC3：发送后模型收到的 `text` 含单行 `[Selected UI element "…" — path: …; text: …]`，`images` 含该 PNG；用户自己写的字仍在 chip 旁边。
- [ ] AC4：删 chip 后绑定图消失，其它附件还在；点 chip 弹出该图预览。
- [ ] AC5：lock 或 DevTools 打开时开关 disabled；Esc 或再点开关可退出并无残留 overlay。
- [ ] AC6：导航 / reload 后页内没有 `#enso-design-mode-*` 之类残留节点；再次打开 Design Mode 仍可用。
- [ ] AC7：`@` mention picker 不出现 UI 元素候选。

## Technical Notes

- 页 → 主进程：用已有 host debugger 做 `Runtime.addBinding`，不要给 guest 加 preload。
- 截图：复用 `browserHost` 的 CDP clip 截图；先对 picker 发 hide，再截 `getBoundingClientRect`，再卸模式。
- 框架名：若能从 fiber / `__vueParentComponent` / Svelte 标记读到组件名，写入 LABEL；读不到就用 `tag#id.class`。失败必须静默，不能抛穿页面。
- 字段上限建议：label 80、path 300、text 200、attributes 20×80。超长截断。
- 纯逻辑必须 TDD：引用行 serialize/parse、payload 收窄、有意义节点判定（若抽到 shared）。React / Electron 窗口不强制单测。

## Key Decisions

| 决策 | 选择 | 日期 |
|---|---|---|
| 交互闭环 | 圈选 → 主 Composer 草稿，不页内提交 | 2026-09-02 |
| 消息形态 | 新 mention chip + 绑定截图，无独立 context 槽 | 2026-09-02 |
| 展开格式 | 单行 Selected UI element 引用块 | 2026-09-02 |
| 删 chip | 同时丢掉绑定图；点 chip 预览图 | 2026-09-02 |
| 快捷键 | 只要工具栏 + Esc | 2026-09-02 |
