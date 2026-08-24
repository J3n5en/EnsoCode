# M1: SessionSupervisor + MessagePort 通路 + 单会话对话跑通

## Goal

M1 最小闭环的第一刀：把 M0 已证伪通过的运行时（`docs/plans/m0-report.md`，故障域 A）
变成正式代码 —— utilityProcess 里的 SessionSupervisor + Main 中转的消息通路 +
Renderer 最小对话窗。验收是**在窗口里发一句话，agent 流式回话**。

## 背景与事实基础

- 设计文档：`docs/plans/2026-08-22-enso-code-design.md` §2（架构与命令集）、§3（数据模型）、§9 M1
- M0 报告：SDK 在 utilityProcess 可加载；同进程双会话并发互不阻塞；abort 单会话不影响另一个；
  jsonl 恢复含 `parentSession`。故障域已选 **A**（一个 utilityProcess 装全部活会话）
- **cursor 分支的原型代码已废弃，不参考、不复用**，本任务从零实现
- 依赖钉死 `@earendil-works/pi-coding-agent`（dev 分支尚未安装）

## Requirements

1. **utilityProcess 入口**：electron-vite 构建出独立的 agent worker 入口，
   Main 能 fork 它、检测其退出/崩溃
2. **SessionSupervisor（child 侧）**：`Map<id, AgentSession>`；命令
   `spawn / prompt / steer / abort`；每会话独立事件订阅并转发为投影事件；
   per-sessionId 的 promise 链操作门（同一会话的生命周期操作互斥）
3. **消息协议（shared 类型）**：按设计文档 §2 冻结的命令集实现最小子集：
   Main→child `spawn/prompt/steer/abort`，child→Main `event`，双向 `snapshot`。
   投影采用**增量事件 + 可重放 snapshot**（未决 #7 就此落定）
4. **Main 中转**：Renderer↔Main 走既有 IPC 三点式（通道常量 / handler / preload 出口），
   Main↔child 走 utilityProcess 消息通道。**Renderer 不直连 child**
5. **provider 接入**：会话的 model/apiKey 来自现有 settings 中已启用的 provider/model；
   apiKey 明文只在 Main→child 传递，不经过 Renderer
6. **Renderer 对话窗**：选择模型 → 开会话 → 发消息 → 流式显示回复；
   `running` 时可 abort；会话消息投影存内存 store（不 persist）
7. **status 语义**：按 §3 的 `idle / running / failed`（本刀无 `waiting/done`，
   权限门与 subagent 不在本任务）

## 明确不做（后续刀）

- 权限门 / 交互块 / 一次性租约（§4）
- diff 视图、行评论
- CLAUDE.md/AGENTS.md 注入
- subagent、会话树、排队输入管理（M1 只需单条 steer 透传）
- utilityProcess 崩溃后的 jsonl 恢复 UI（本刀只要求崩溃被检测并把会话标 `failed`）

## Acceptance Criteria

- [ ] `pnpm dev` 后在窗口内：选模型 → 发一句话 → agent 回复流式出现
- [ ] agent `running` 期间点 abort，turn 终止,会话回到 `idle` 可继续发话
- [ ] 手动杀掉 utilityProcess，UI 将该会话标为 `failed`，app 不崩
- [ ] apiKey 不出现在 Renderer 可见的任何 IPC 载荷里
- [ ] 消息协议与 supervisor 的纯逻辑部分有 Vitest 覆盖
- [ ] `pnpm typecheck && pnpm lint && pnpm test` 干净，无调试残留
