# 实现清单

按 TDD：先红灯协议/解析，再接线。UI 最后。

1. **shared 协议（先测）**  
   `src/shared/browser/designMode.ts`：`formatUiElementRefLine` / `parseUiElementRefLine` / `sanitizeUiElementPayload`。用例：往返、引号/换行净化、超长截断、非该行返回 null。

2. **mention 类型**  
   `UiElementMentionCandidate` + `parseMentionCandidate` + `mentions.test.ts`。`MentionSegment` 与 `serializeSegments` / `splitInlineMentions` / `mentionDisplayText` / `createEditorPayload` 同步改，补 `mentionComposer.test.ts`。抽 `unbindImages(images, imageIds)` 测删 chip 丢图。

3. **picker 脚本**  
   `pageScripts.ts` 增加 enable/disable/hide/pick 脚本字符串。页内逻辑保持自包含 IIFE；有意义节点判定若能纯函数化可抽到 `designMode.ts` 用 jsdom 测，否则脚本内联、用少量 fixture 字符串断言关键消息名。

4. **IPC 三点**  
   `IPC_CHANNELS.BROWSER_SET_DESIGN_MODE`、`BROWSER_DESIGN_MODE_EVENT`。`ipc/browser.ts` + preload。coverage fixture 标 renderer-only。`BrowserTabState` 加 `designMode: boolean`。

5. **browserHost**  
   `setDesignMode`、binding、picked 单飞、hide+CDP clip、与 `setLocked` / DevTools / navigate 互斥。不新增 `BrowserOp`。

6. **Composer 桥**  
   `insertUiElementMention`：插入段 + 注册图片。`AttachedImage` 编辑器侧带可选 `id`（发给 agent 前剥掉）。chip 点击 popover。`@` picker 不列该 kind。

7. **BrowserView**  
   笔形开关、`aria-pressed`、Esc、lock/devtools disabled、i18n（`Toggle Design Mode` / `Design Mode` / 预览失败 toast）。

8. **验证**  
   `pnpm typecheck && pnpm test`；`biome check` 改过的文件。真机：example.com 点一个链接，确认 Composer chip + 无框截图 + 发送文本行。

## 风险文件

- `mentionComposer.ts`：发送/回放正则必须同步，改漏会破坏历史 chat chip。
- `browserHost.ts`：debugger 同时服务 DevTools 互斥与截图。
- `pageScripts.ts`：注入字符串转义；语法错误会让整个 tab JS 失败。

## 回滚点

先合 shared 协议 + mention 而不开工具栏，可独立回滚。host 开关与 UI 绑在同一提交亦可接受，但不要和无关 browser 重构混提。

## `task.py start` 前

- [x] PRD 收敛、无阻塞开放问题
- [x] design.md / implement.md
- [ ] implement.jsonl / check.jsonl 已填真实 spec（本步写）
- [ ] 用户批准本规划摘要后才能 `start`
