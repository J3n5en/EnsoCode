# Design Mode 涂鸦冻帧 — 技术设计

## 边界

在 09-02 圈选链上加一条旁路，**不改** `ui-element` 发送行、不新增 agent 工具。

```
Design Mode 开
    │
    ├─ 未达阈值松手 → 现有 click pick（元素 clip）
    │
    └─ ≥300ms 且位移 >5px
           │  hide picker chrome
           │  host CDP 视口截图 → dataURL 回页
           ▼
        guest 冻帧 + canvas scribble
           │  多笔；第一笔 pointerup 出「添加到对话 / 取消」
           ├─ 取消 / Esc → 卸冻帧，designMode 仍 true
           └─ 添加到对话
                  │  hide 按钮与笔迹 chrome
                  │  合成 PNG + area grounding payload
                  │  binding { type: 'annotated', payload, image }
                  ▼
              同 09-02：关 Design Mode → insertUiElementMention → 聚焦 Composer
```

guest 仍无 preload。冻帧、画布、按钮都在 guest 顶层（`WebContentsView` 会挡住 renderer 弹层）。

## 模块

| 层 | 文件 | 职责 |
|---|---|---|
| shared | `designMode.ts` | 新增：阈值常量、包围盒、中心点、scribble 点净化、`mergeAnnotationImage` 不在此（需 canvas/DOM） |
| shared | `pageScripts.ts` | picker 增加长按检测 / 冻帧层 / 多笔 / 双按钮；binding 多 `annotated` |
| shared | `types/browser.ts` | `BrowserDesignModeEvent` 增 `annotated`（可与 `picked` 同形，用 type 区分来源） |
| main | `browserHost.ts` | `freeze`：视口截图回传；收 `annotated` 与 `picked` 一样插图；`setDesignMode(false)` 只在提交或工具栏关 |
| renderer | Composer 桥 | 复用 `insertUiElementMention` + 聚焦输入框；不调 submit |

## 手势状态（页内）

```
idle ──pointerdown──► pending
  ▲                     │ timer 300ms 且 move>5px → freezing（等 host 帧）
  │                     │ pointerup 且未 freezing → click pick
  │                     ▼
  │                  annotating（冻帧+canvas）
  │                     │ 多笔
  │                     │ 第一笔 up → 显示 actions
  ├─ cancel/Esc ────────┤
  └─（提交后由 host disable）
```

`pending` 期间继续 hover 画框。进入 `freezing` 立刻 hide chrome，避免冻进紫框。

## Host 协议增量

页→主（binding JSON）：

| type | 何时 | host |
|---|---|---|
| `picked` | 单击（未进涂鸦） | 同 09-02 |
| `freeze-request` | 阈值达到 | `Page.captureScreenshot` 视口（先 hide）；`runGuest` 把 dataURL 交给页内 `showFrozenFrame` |
| `annotated` | 点添加到对话 | payload = grounding 元素（中心命中 \|\| 按下 hover）；image = 合成 PNG |
| `cancelled` | 仅工具栏关 / 用户 Esc **且当前不在 annotating**？ | 09-02 已关模式。annotating 时 Esc 只页内卸冻帧，**不**发 `cancelled` |

取消保持开启：页内自己 `exitAnnotation()`，不调用 `setDesignMode(false)`。

`annotated` 与 `picked` 共用 renderer 监听即可（都是 chip + 图）。type 留下便于日志。

grounding：页内用与 click 相同的 `meaningful()`。中心 `elementFromPoint`；失败用 `pressHoverEl`。两者空 → 不发 `annotated`，按钮可 disabled 或 toast。

## 合成图

优先页内 canvas：`drawImage(冻帧)` + 按点重放 scribble（线宽/色与预览一致）→ `toDataURL('image/png')`。host 只收 base64，不再二次截「带按钮的帧」。提交前必须 hide 按钮。

点净化（shared，可单测）：有限点数、有限坐标、包围盒；空笔 / 单点拒绝提交。

## Composer

不改 mention 协议。`insertUiElementMention` 后聚焦已有 editor。i18n：`Add to conversation` / `Cancel`（中文表「添加到对话」「取消」）。

## 互斥

与 09-02 相同。额外：DevTools 中途打开 → host disable → 页内脚本随 disable 卸冻帧。lock 同。

## 测试

必须（TDD，纯函数）：

- 阈值：`(heldMs, movePx) → pending | annotate | click`
- 包围盒 / 中心点
- 点列净化（空、单点、NaN、超长截断）
- binding 事件 type 收窄（若抽 parse）
- 现有 `picked` 发送行回归仍绿

不强制：canvas 合成、Electron 窗口、真页长按。

## 回滚

删页内涂鸦分支与 `freeze-request`/`annotated` 处理，工具栏文案不动。`picked` 路径保持。
