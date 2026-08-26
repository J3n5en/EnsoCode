# 技术设计 — 文件 checkpoint

## 模块

```
src/agent/checkpoint/
  core.ts     vendored pi-rewind core(纯 git 操作,零 pi 依赖):
              git()/createCheckpoint/restoreCheckpoint/loadAllCheckpoints/
              pruneCheckpoints/pruneOldSessions/过滤器
  manager.ts  CheckpointManager:per 顶级会话;懒探测 git root;
              ensureTurnCheckpoint()(每轮一次,记当轮 user entry id+时间戳);
              restoreForEntry(entryId, timestamp)(选择策略见下);
              withCheckpoint(tool) 工具包装器
```

## 快照时机:mutating 工具包装器(非事件钩子)

`withCheckpoint` 包在 bash/edit/write 外层(与 withApproval 同构,tool.execute 是被 await
的,可安全阻塞 ~100ms)。首个 mutating 工具执行前 `await ensureTurnCheckpoint()`:
- 每轮一次:supervisor 在 `agent_start` 重置轮标志。
- 快照元数据记当前分支最后一个 user entry 的 id 与时间戳(= 本轮的 user 消息)。
- 非 git repo / git 失败:置 disabled,静默跳过(不影响工具执行)。

覆盖路径完备性:prompt/steer/coworkerSend/通知唤醒全部经工具执行收口,无需在多个
入口埋点。只有 turn 真的写盘才产生快照(读-only 轮零成本)。

## 还原选择策略

回退目标 user entry E(id、timestamp 已知):
1. 精确:checkpoint.entryId === E.id → 即 E 那轮首个写操作前的状态。
2. 降级:E 那轮没写盘 → 取 timestamp ≥ E.timestamp 的最早快照(E 之后最先发生的
   写操作前的状态,等价于「E 时刻」的工作树)。
3. 无命中:E 之后无任何写盘,工作树本就是目标状态 → 只回退对话。

还原前打 `before-restore` 快照。用 id+timestamp 而非序号:navigateTree 产生分支后,
序号在新旧分支间歧义,entry id 恒稳定。

## 命令/事件变更

- `AgentCommand.rewind` += `restoreFiles?: boolean`。
- `rewind-done` += `filesRestored?: boolean`(UI 现阶段不消费,预留)。
- worker rewind 流程:定位 target entry(P0 逻辑)→ 若 restoreFiles:
  restoreForEntry(先于 navigateTree,读旧分支状态无依赖,顺序无关;放 navigateTree
  之前,失败时对话不回退,保持「文件与对话一致」)→ navigateTree → reconcile → rewind-done。

## UI

RewindButton 拆两个 hover 按钮:「回退」(仅对话)与「回退+还原文件」。渲染层不感知
是否 git 项目,还原不可用时 worker 静默降级为仅对话。

## 局限(记录)

- coworker/subagent 的写操作不触发快照;父会话快照是整树的,还原会连带覆盖
  coworker 在两个快照之间的改动(共享工作区固有语义)。
- 轮与轮之间用户手工改的文件会被卷入下一个快照(快照即时刻真值)。

## 回滚

纯增量(新目录 + 工具包装 + 命令可选字段)。移除 withCheckpoint 包装与 UI 按钮即回
P0;refs/enso-checkpoints 可 `git for-each-ref --format='%(refname)' | xargs -n1 git update-ref -d` 清理。
