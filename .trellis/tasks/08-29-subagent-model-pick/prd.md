# subagent / coworker 支持主 agent 指定模型

## 背景

`subagent` / `coworker` 工具目前的子会话模型链是
`resolved?.model ?? agentType?.model ?? 父会话 model`（supervisor.createChildSession）。
主 agent 无法按任务挑模型（如简单子任务用便宜模型）。模型凭证只在 main 进程解析
（agentHost.resolveModelSelection → SpawnModelConfig 含 apiKey），worker 没有模型目录。

## 用户决策

- 可选模型范围由用户在「模型中心」逐模型勾选（新增开关），而非自动暴露全部模型。
- 工具调用显式指定的 model 优先于 agent_type 绑定模型。

## 方案

### 1. shared 层

- `ModelEntry` 增加 `subagent?: boolean`（缺省 false = 不暴露给子代理）。
- 新类型 `SubagentModelOption { name: string; config: SpawnModelConfig }`，
  `name` 是给 LLM 看的唯一键（`{provider.name}/{modelId}`，冲突时追加区分）。
- `spawn-parent` 命令与 parser 增加 `subagentModels?: SubagentModelOption[]`。

### 2. main 层（agentHost.ts）

- `configuredSubagentModels(authenticatedAccountKeys)`：遍历有凭证且启用的 provider，
  取 `enabled !== false && subagent === true` 的模型行，经 `resolveModelSelection`
  得到 config；随 spawn-parent 下发（模式对齐 `configuredAgentTypes`）。

### 3. worker 层

- `supervisor.spawn` 接收 `subagentModels`；`factory.createChildSession` 增加
  `modelOverride?: SpawnModelConfig`，优先级：
  `modelOverride ?? resolved?.model ?? agentType?.model ?? 父模型`。
- `subagent` 工具：新增可选参数 `model`（枚举下发的 name，description 列出选项并
  引导「简单任务挑便宜模型」）；未知值报错并列出可用项。SubagentInfo.modelId 如实上报。
- `coworker` 工具：`spawn` 操作新增可选 `model` 参数，透传 spawnCoworker →
  createChildSession。resume 时若模型开关已撤销/漂移，降级回 agentType/父模型
  （对齐 agentType 漂移降级策略，不毁恢复）。

### 4. renderer 层（模型中心）

- `ProviderModelRow` 增加「子代理可用」开关；API-key 与 OAuth 订阅行都要能设置
  （注意订阅行 `canOverride=false` 不展开，开关需放行级而非展开区,或单独放行级图标开关）。
- i18n 补中英文案。

## 不在范围

- typed-mention 子会话（spawn-child + ResolvedAgentTypeSpawnConfig 证明链）不受影响。
- 不做 per-call thinking level 覆盖。
- coworker 中途换模型不做（仅 spawn 时指定）。

## TDD 覆盖点

1. 子会话模型选择优先级（抽纯函数或经 factory 测试）。
2. spawn-parent parser：`subagentModels` 合法/非法输入。
3. `configuredSubagentModels` 过滤逻辑（未勾选/未启用/无凭证不出现）。
4. subagent/coworker 工具：`model` 参数合法透传、未知值报错文案含可用列表。

## 验收

- 模型中心勾选模型 → 新会话中主 agent 的 subagent/coworker 工具 schema 出现 model 选项。
- 指定 model 的子代理实际用该模型（SubagentInfo/CoworkerInfo.modelId 正确）。
- 未勾选任何模型时工具行为与现状完全一致（无 model 参数）。
- `pnpm typecheck && pnpm test` 通过，`biome check` 干净。
