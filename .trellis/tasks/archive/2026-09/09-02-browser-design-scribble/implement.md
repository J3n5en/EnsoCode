# 实现清单

依赖 09-02 已合的圈选闭环（`designMode.ts` / picker IIFE / `insertUiElementMention`）。本任务不改发送行。

1. **shared 手势纯函数（先红）**  
   `designMode.ts`：`DESIGN_SCRIBBLE_HOLD_MS = 300`、`DESIGN_SCRIBBLE_MOVE_PX = 5`、`scribbleGesture(heldMs, movePx)`、`scribbleBounds(points)`、`boundsCenter`、`sanitizeScribblePoints`。`designMode.test.ts` 补用例。实现时不改已有 serialize 测试。

2. **事件收窄**  
   `BrowserDesignModeEvent` 增加 `annotated`（字段同 `picked`）。可选 `parseDesignBinding` 测未知 type 丢弃。

3. **pageScripts**  
   pending / freeze-request / 冻帧层 / scribble / 第一笔后按钮。字符串断言：`freeze-request`、`annotated`、`添加到对话` 或 i18n key、`hold`/`300`。修复注入字符串转义（不要再写裸 `\s`）。

4. **browserHost**  
   处理 `freeze-request`（hide → 视口截图 → `showFrozenFrame(dataUrl)`）。`annotated` 走与 `picked` 相同的插图+关模式。annotating 期间 `cancelled` 从页内不发。`setDesignMode(false)` 仍卸一切。

5. **renderer**  
   `onDesignMode` 对 `annotated` 复用 insert + focus。i18n 两键。按钮不进 BrowserView（在 guest）。

6. **验证**  
   `pnpm typecheck && pnpm test`；`biome check` 改过的文件。真机：单击回归；长按拖开画 → 松手双按钮 → 添加到对话进草稿；取消后仍能圈选。

## 风险

- `pageScripts.ts` 模板转义；语法错会弄死 tab JS。
- 冻帧往返：截图像素与 CSS 像素比（devicePixelRatio）要对齐，否则笔迹错位。
- `pointerdown` preventDefault 已存在，涂鸦必须改听 `pointerup`（09-02 点击修复同因）。
- 合成图若误截到按钮，模型会看见「添加到对话」。

## 回滚点

先合 shared 函数 + 事件类型，不接线也可回滚。页内涂鸦与 host freeze 同一提交。

## `task.py start` 前

- [x] PRD 收敛、无阻塞开放问题
- [x] design.md / implement.md
- [ ] implement.jsonl / check.jsonl
- [ ] 用户批准本规划摘要后才能 `start`
