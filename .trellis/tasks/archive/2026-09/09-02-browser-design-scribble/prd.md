# Browser Design Mode：长按涂鸦冻帧仍走 ui-element

## Goal

在已落地的单击圈选之外，Design Mode 支持 **长按 → 冻结视口 → 涂鸦/框选**。提交后仍插入主 Composer 的 `ui-element` chip，绑定图改为「冻帧 + 笔迹」合成图，chip 文本仍是元素 LABEL / PATH / TEXT。不新增 agent 工具，不把选区写成 snapshot `ref`。

## Background

父任务 `09-01-enso-in-app-browser`。并列子任务 `09-02-browser-design-mode` 已交付单击圈选闭环；其 PRD 把「涂鸦 / 冻结视口帧」标为非目标，故另开本任务。

Cursor 3.18（`workbench.glass.main.js`）两条手势：

- `annotationMode === "element"`：单击节点 → 藏 picker → clip 元素矩形 → `design-element.png` + `uiElementSelections`。
- 非 element：`pointerdown` 先进入 `drawing`；位移 **> 5px** 才算开画（`shift` → `box`，否则 `scribble`），此时冻帧。**松手不进聊天**，状态切到 `commenting`（页内批注框 / Add to chat）。合成图是冻帧 + `points` → `design-annotation.png`，再用包围盒中心做 area grounding。

Enso 约束（沿用 09-02）：

- Composer 只有 `text + images + mentions`；`ui-element` 发送展开为 `[Selected UI element "LABEL" — path: PATH; text: TEXT]`。
- guest 无 preload；页→主进程仍走 `Runtime.addBinding('ensoDesignMode')`。
- 截图走 host CDP；DevTools 开时不可用；lock 与 Design Mode 互斥。
- `WebContentsView` 盖住 renderer，冻帧画布必须在 guest 页内（或沉 guest），不能只做 HTML overlay。
- 09-02 闭环：选完关 Design Mode，落到主 Composer 草稿；**不做页内批注输入、不当场 `submitMessage`**。本任务允许冻帧上出现「添加到对话 / 取消」。

用户已选产品形态 **选项 2**：涂鸦结果仍是 `ui-element` chip，图是冻帧+笔迹，文字仍绑元素 path/text。

## Requirements

- **R1 手势分流**：单击 / 未达阈值的按下仍走 09-02 圈选。进入涂鸦必须同时满足 **按住 ≥ 300ms** 且 **位移 > 5px**；一旦进入，这次手势不得再触发单击 pick。
- **R2 冻帧**：进入涂鸦后先藏 picker chrome，再截当前视口（或可覆盖笔迹包围盒的一帧），叠在页上不再跟随页面滚动/动画。
- **R3 画布**：第一刀只要自由线 `scribble`（无 `box`、无模式切换）。冻帧上可连续多笔；笔迹画在冻帧上，不写进宿主 DOM。
- **R4 闭环**：进入涂鸦后可多笔画。**第一笔松手**后在冻帧上出现 **添加到对话 / 取消**（无批注输入框）。「添加到对话」：关 Design Mode、卸冻帧/画布，向主 Composer 插入 `ui-element` chip + 合成 PNG，并聚焦输入框，**不自动发消息**。发送行格式与 09-02 相同。按钮画在 guest 冻帧上。
- **R5 元素绑定**：chip 的 LABEL/PATH/TEXT 优先取**笔迹包围盒中心**命中的「有意义」节点（area grounding）；中心落在空白 / 非节点上则回退到**按下瞬间的 hover 节点**。两者都没有则取消提交、不插空 chip。
- **R6 互斥与清理**：lock / DevTools 规则同 09-02。取消或 Esc：卸冻帧/画布/按钮、**不插 chip、Design Mode 保持开启**（回到 hover 圈选）。导航 / reload / 关 tab / 点工具栏关开关：卸全部页内节点。
- **R7 边界**：不新增 `browser_design_*`、不把任意 CDP 给模型、不改 mention 发送格式、不进 `@` picker。

## Out of Scope

- 页内批注输入框、当场 `submitMessage`（冻帧上只有添加到对话 / 取消）
- `box` 虚线框 / 模式切换（Cursor 用 shift+拖）
- 多选色相、撤销栈、压感、颜色选择器
- 父/子/兄弟树导航
- Canvas / 中央编辑器 Design Mode
- 可配置快捷键
- HMR fingerprint 重绑
- 框架 props 全量序列化

## Acceptance Criteria

- [ ] AC1：Design Mode 下单击行为与 09-02 一致（chip + 元素 clip，无笔迹）。
- [ ] AC2：长按进入冻帧后，页面动画/滚动不再更新底图；紫框隐藏。
- [ ] AC3：冻帧上可画多笔。第一笔松手出现「添加到对话 / 取消」，此时还不进 Composer。点添加到对话后：chip + 合成图进主 Composer 草稿，输入框聚焦，消息未发出。
- [ ] AC4：用户在 Composer 发出后，模型收到的 `text` 仍是单行 `[Selected UI element "…" — path: …; text: …]`，`images` 含该 PNG；可与用户补打的字在同一条。
- [ ] AC5：点取消或 Esc：无 chip、无残留冻帧 / canvas / 按钮，Design Mode 仍开（可继续圈选或再画）。工具栏再关一次才退出模式。
- [ ] AC6：未同时达到 300ms 与 5px 就松手，视为单击圈选（或空点），不出现添加到对话/取消、不插空涂鸦 chip。
- [ ] AC7：lock / DevTools 打开时不能进入涂鸦；DevTools 打开后进行中的冻帧取消。

## Key Decisions

| 决策 | 选择 | 日期 |
|---|---|---|
| 消息形态 | 仍走 `ui-element` chip，图改为冻帧+笔迹 | 2026-09-02 |
| 任务拆分 | 不塞进 09-02，单开本子任务 | 2026-09-02 |
| 元素绑定 | 包围盒中心命中，失败回退按下 hover | 2026-09-02 |
| 提交时机 | 第一笔松手出「添加到对话 / 取消」 | 2026-09-02 |
| 添加到对话 | 进主 Composer 草稿并聚焦，不自动发 | 2026-09-02 |
| 画布 | 第一刀只要 scribble | 2026-09-02 |
| 进入阈值 | 按住 ≥ 300ms 且位移 > 5px | 2026-09-02 |
| 取消 | 卸冻帧，Design Mode 保持开启 | 2026-09-02 |

## Open Questions

（无。产品决策已收口。）
