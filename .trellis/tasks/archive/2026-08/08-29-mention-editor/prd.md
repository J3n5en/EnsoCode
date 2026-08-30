# Mention Editor — 输入框真·卡片提及(Cursor 式)

## 需求(用户明确)

1. 输入框内 @文件 / @过去会话 都渲染成**带图标的卡片**(藏 @、显示文件名/标题)
2. 卡片是**原子块**:Backspace 整块删除,光标视其为单个单位
3. 卡片**内联**在文本任意位置,顺序/位置语义保留(chats 也获得位置语义)
4. 发出的气泡与输入框同款卡片、同位置

## 架构决策

- textarea → **contentEditable**(等宽叠层做不了图标/藏 @,已验证并与用户对齐)
- 卡片 = `<span contenteditable="false" data-mention-kind data-payload>`,浏览器原生把
  cE=false 岛当原子块(Backspace 整删 ✓)
- **DOM 为编辑期事实源**,序列化为 wire text 发送:
  - file → `@relativePath`(原位)
  - chat → `[Referenced past chat "title" — transcript file: X (...)]`(原位内联,不再尾部追加)
- 气泡渲染:新增 `splitInlineMentions`(text/file/chat 三种段,全文扫描);
  `splitMentionRefs` 保留做旧消息尾部块兼容
- @query 检测:取光标所在 text node 内、光标前的 `@token`(卡片是节点边界,天然隔离)
- slash 检测:仅编辑器首个节点为 text 时,按现有 findSlashStart
- 草稿:序列化段列表存 drafts Map;切会话恢复重建 DOM
- Enter 发送 / Shift+Enter 换行(insertLineBreak);粘贴强制纯文本;IME 用现有 composition 事件
- placeholder:CSS empty::before
- recipient(agent-type)保持编辑器外的顶部 chip,不参与内联

## 分层实施

1. 纯逻辑(TDD):`mentionSegments.ts` — serializeSegments / splitInlineMentions /
   caretMentionQuery(节点内 @ 检测)
2. `MentionEditor.tsx`:contentEditable 组件,ref 命令式 API
   (insertMention/replaceMentionToken/getSegments/setSegments/clear/focus)
3. Composer 接线:替换 textarea,popup/keyboard/draft/send 迁移
4. TimelineRow:splitInlineMentions 渲染(带图标卡片,两端同款)
5. CDP 真机全链路 + 中文 IME 手测提示

## 不做

- phone 端(有独立 composer)
- 卡片内编辑、拖拽排序

---

## 执行结果（2026-08-31 归档）

已全部落地（见 git log）：

- `8464d64` contentEditable 提及编辑器，@文件/@会话成为原子内联卡片（主提交）
- `b799069` 修复：补回两行最小高度（对齐旧 textarea rows=2）
- `3015dec` 修复：卡片与正文垂直居中（align-middle），CJK 下不再偏高

前置演进链：`33a6a56`（Past Chats @ 提及）→ `1aad972`（chip 形态）→
`7549469`（内联 token 保位置语义）→ `123568b`/`404f96c`（两端样式统一）。
