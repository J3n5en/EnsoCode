# 执行计划 — 会话回退(仅对话)

按依赖序小步提交,每步可独立 typecheck。

## Checklist

1. [ ] **shared 类型**:`src/shared/types/agent.ts`
   - `AgentCommand` 加 `rewind`;事件联合加 `rewind-done`;`parseAgentWorkerEvent` 校验补 case。
2. [ ] **worker**:`src/agent/supervisor.ts` `execute()` 加 `case 'rewind'`
   - idle 守卫;getBranch 倒数定位 user entry;navigateTree;reconcileMessages;emit rewind-done。
3. [ ] **main IPC + preload**:`src/main/ipc/agent.ts` 转发、`src/preload/index.ts` 暴露
   `agent.rewind(sessionId, userIndexFromEnd)`(照 setThinking 样板;确认 IPC_CHANNELS 是否需加)。
4. [ ] **renderer store**:`src/renderer/stores/sessions/index.ts`
   - `rewind(conversationId, userIndexFromEnd)` action;onEvent 处理 `rewind-done` → 写
     per-conversation `draftText`(新字段)+ 消费接口。
5. [ ] **UI**:聊天时间线 user 消息组件加 hover「回退到此处」入口(idle && started 才渲染);
   ChatInput 挂载/更新时消费 `draftText` 预填并清除。
6. [ ] **测试**:supervisor 定位逻辑(倒数第 N 条 user entry)与 reducer 回放路径若有现成
   测试文件则补用例(projection.test.ts / reducer 相关);无则仅手动验证。

## 验证命令

```bash
pnpm typecheck && pnpm lint && pnpm test
```

手动:pnpm dev → 建会话发 3 轮 → 回退到第 2 条 user 消息 → 校验时间线截断/输入框预填/
重发新分支 → 重启 app resume 校验回放新分支 → 检查 jsonl 旧 entry 仍在。

## 回滚点

每步一个 commit;整体回滚 revert 区间即可,无数据迁移。
