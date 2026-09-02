# AI 会话标题总结

## 背景

侧边栏会话标题目前是「首条用户消息截断」：桌面 spawn 时 `slice(0, 40)` 存进
`conversation.title`（`src/renderer/stores/sessions/index.ts`），手机端建的空标题会话
用 `firstUserText` 补。没有任何 AI 参与，长指令类消息的标题可读性差。

## Goal

设置里新增「标题总结」开关 + 独立模型选择；用户发出**首条消息后立即**（不等回合完成）
用一次性补全（pi `ModelRuntime.completeSimple`）生成 ≤20 字短标题，自动替换截断标题。

## Requirements

### R1 设置项

- `titleSummaryEnabled: boolean`，缺省 **false**（避免升级后所有用户静默多烧 token）。
- `titleSummaryModel: DefaultModelRef | null`，`null` = 跟随全局默认模型。
- 设置页模型区新增一个 section：开关 + 模型选择器，模型选择器复用
  `DefaultModelPicker` 的模式（`ModelPicker` 组件 + `usableProvidersForOauthSnapshot`
  候选过滤）。不需要推理/思考档位（标题总结不开推理）。
- 两个字段加进 `SETTINGS_STATE_FIELDS` 同步白名单（`src/main/ipc/settings.ts`）；
  settings persist 版本迁移按现有 `migrate.ts` 惯例补缺省值。
- 模型失效兜底：解析不到 `titleSummaryModel`（provider 被删/登出）时回退全局默认模型；
  全局默认也没有则本次静默跳过。不做 revalidate 写回。

### R2 触发时机与调用链

- 触发点：renderer 发送**会话首条用户消息**的路径上（spawn 新会话那条分支），
  设置开启时并行发起，不阻塞正常发消息/spawn。
- 调用链对齐既有模型解析纪律（renderer 只传 providerId+modelId，凭证 Main 补全）：
  1. renderer → Main 新 IPC（如 `AGENT_SUMMARIZE_TITLE`）：`{ conversationId, text }`；
  2. Main 读设置解析标题模型（`resolveModel` + OAuth credentialKeys，含 R1 回退），
     组装 `SpawnModelConfig` 下发 worker 新命令 `summarize-title`；
  3. worker：`resolveBaseModel(runtime, model)` → `runtime.completeSimple` 一次性补全
     （不创建 AgentSession、不落 session 文件）；
  4. worker 回流事件（如 `{ type: 'title-generated', conversationId, title }`）→
     Main 转发 → renderer 写回。
- Prompt 要求：输出语言跟随用户消息语言；只输出标题本身（无引号/句号/前缀）；
  ≤20 字；用户消息过长时截取前 N 字符（如 2000）再送。

### R3 写回规则

- 收到 `title-generated` 时，仅当当前 `title` 仍等于触发时记下的自动截断标题才覆盖
  （用户已手动改名 / 会话已删除 → 丢弃结果）。
- 覆盖走现有 `renameConversation` 同款约束（trim + 80 字上限），随 partialize 持久化。
- 失败/超时（建议 ~15s）静默放弃，保留截断标题；不重试、不弹错误。
- 每个会话最多触发一次（只在首条消息路径触发，天然幂等；resume 不触发）。

## Out of Scope

- 历史旧会话批量补总结；手机端（phone PWA）建会话的标题总结（保留 firstUserText 兜底）。
- coworker/child TAB 标题；导入会话（`[imported]`）的标题。
- 等首轮完成后结合 assistant 回复再总结（已定：首条消息即总结）。
- 标题总结的推理档位/思考深度配置；token 用量统计展示。

## Acceptance Criteria

- [ ] 设置页可开关标题总结、可单独选模型；重启后配置保留；不选模型时跟随全局默认。
- [ ] 开关开启时新会话发出首条消息后标题自动变为 AI 短标题（中文消息得中文标题）。
- [ ] 关闭开关时行为与现状完全一致（截断标题）。
- [ ] 生成期间手动改名后，生成结果不覆盖手动标题。
- [ ] 标题模型不可用（凭证失效等）时静默回退/跳过，发消息与会话运行不受任何影响。
- [ ] 逻辑单测（TDD）：设置字段迁移与缺省值、Main 模型解析回退链、写回守卫
      （标题未变才覆盖）、prompt 组装截断；`pnpm typecheck && pnpm test` 全绿。
