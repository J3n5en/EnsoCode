# 停在会话里等它完成，侧栏仍亮绿点

## 症状

桌面和手机完整版（/desk）同时在线时，停在某个会话里等这一轮完成，侧栏这一行完成后亮起绿点，切走再切回才熄。只开一个主界面时不复现。容易误认成「运行中状态没更新」。

## 根因

绿点是 `unread`（`conversationDotTone` → `ConversationStatusIndicator`），不是运行中（运行中是品牌色）。`status` 是 runtime 键，各主界面由 worker 事件驱动，能及时变 idle；`unread` 却是持久化字段，靠会话补丁在主界面之间同步。

每个 renderer 在 running→idle 时按**自己的** `activeId` 判是否已读（`nextUnread`）。没在看的那一端置 `unread=true` 并写回，Main 把差量推给其他主界面，`applyConversationsPatchToState` 原样合入，于是正在看这个会话的一端也被标成未读。

## 修法

`remotePatch.ts` 合入补丁时，若会话是本端 `activeId` 或手机正在订阅的会话（`isPairViewed`），把 `unread` 改回 `false`；本端写回会把 `false` 同步给其他主界面。没人在看的会话照常标未读。

## 回归防线

`src/renderer/stores/sessions/remotePatch.test.ts`：正在看 / 重同步整行 / 手机订阅三种情况都不接收远端未读，其他会话照常。

## 相关代码

- `src/renderer/stores/sessions/remotePatch.ts`
- `src/renderer/stores/sessions/unread.ts`
- `src/renderer/stores/sessions/index.ts`（`onConversationsPatch` / `onConversationsResync`）
