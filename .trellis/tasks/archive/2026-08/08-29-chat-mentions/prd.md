# @ Chats — 提及过去会话(Cursor 式 Past Chats)

## 决策(已与用户对齐)

- **注入形式:A jsonl 路径引用**。发送时在消息文本尾部追加引用块:
  `[Past chat "标题" — transcript: <sessionFile>(pi session jsonl,按需 read)]`
  agent 用 read 工具自己按需读,不内联、不摘要。
- **候选范围**:当前项目的 root 会话(无 parentId)、有 sessionFile、排除当前会话,
  按 createdAt 倒序,上限 20。数据源 = 渲染层 sessions store,无新 IPC。
- **交互**:选中后不在文本里插 token(标题含空格会破坏 @ token 解析),
  走 chip 形态(对齐 recipient chip),可 X 移除。
- **UI**:复用刚落地的 folder 机制。空查询根级 = [Agents 文件夹, Chats 文件夹, ...files];
  有关键词时摊平,标题命中即出现在 chats 组。

## 实现清单

1. shared/types/mentions: `ChatMentionCandidate { kind:'chat'; id; label; sessionFile }` 入 union
2. mentionComposer(纯逻辑,TDD):
   - `groupMentionCandidates` / `flattenMentionRoot` 支持 chats 组与第二个文件夹
   - `createComposerPayload` 追加 chat 引用块
3. Composer:`openFolderId: 'agents'|'chats'|null` 取代 folderOpen boolean;
   pickMention 处理 kind:'chat';chips 行渲染
4. MentionPicker:两个文件夹行 + chats flyout
5. useMentionSearch:从 sessions store 取 chat 候选

## 不做

- 摘要生成(后续可演进)
- 跨项目会话引用
- phone 端
