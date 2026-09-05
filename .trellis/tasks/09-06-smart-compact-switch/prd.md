# Smart compact optional switch

## Goal

用户可以在设置里打开「验证式智能压缩」。打开后，主会话的自动/手动 compact 先走 `pi-smart-compact` 的可验证摘要；失败或未启用时行为与现在完全一致（Pi 原生 compact）。

## Requirements

- 设置中有一项开关，**默认关闭**。关闭时不加载该扩展，不改 compact 路径。
- 打开后仅影响**父会话**的 compact 摘要；子代理 / coworker / Enso locked 会话不加载。
- `/compact` 与宿主自动 compact 共用同一条路径：扩展挂在 `session_before_compact`，真正改会话仍由 Pi `session.compact()` 完成。
- 扩展失败、验证不过、超时、包加载失败：回退原生 compact，会话不卡死、不丢消息。
- 不新增 `/smart-compact` 产品命令；不在本期做 loops 管理器、context graph UI、`smart_recall` / `smart_save_memory`。
- 打开时写入/合并扩展所需的安全默认配置：不要求 TUI 审批、关闭图谱与 agent 工具、自动触发走 native hook。
- 开关文案过 i18n；中英文都要说明「更稳但可能更慢/更费 token，失败会回退默认压缩」。
- 已有会话：开关对**之后新 spawn / 重启后的会话**生效，不要求热切换正在跑的 worker 会话。

## Constraints

- 不内嵌或 fork EESV 流水线；以 npm 包 `pi-smart-compact` 为扩展加载。
- 不绕过 Pi 自己 apply compact（不自己改 session 消息）。
- 设置持久化走现有 `settings.json` / zustand persist，字段加入主进程可读列表。
- 新增 `spawn-parent` 字段必须进 `parseAgentCommand` 白名单，否则 worker 会丢命令。
- 不把扩展的 TUI、SQLite 图谱、跨会话记忆做成默认能力。

## Acceptance Criteria

- [ ] 默认关闭：父会话 `createAgentSession` 不加载 `pi-smart-compact`，compact 与现在一致。
- [ ] 打开后：新父会话的 resource loader 带上该扩展路径；子会话仍 `noExtensions` / 不带此路径。
- [ ] `spawn-parent` 脏输入（缺字段、错类型）仍被 `parseAgentCommand` 拒绝；合法布尔字段能通过。
- [ ] 设置页可开关，刷新/重启后保持；未出现过该字段的旧 `settings.json` 视为关闭。
- [ ] 扩展配置合并只动 `smartCompact` 段，不擦掉用户已有的其它 Pi 设置键。
- [ ] 扩展加载抛错时父会话仍能 spawn，compact 走原生。

## Notes

- loops 管理器与 context graph 明确不在本期范围。
- 兼容性风险：扩展在 Node 侧用 `node:sqlite`；若 Electron utilityProcess 不可用且导入即执行，必须保证加载失败可回退。
