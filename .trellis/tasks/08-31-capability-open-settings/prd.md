# 开放 agent 能力：subagent-models 推理选项 + enso_app 集成

## 背景

- `providers.subagent-models` 在能力目录中标记 `unavailable`（catalog.ts:466），理由已过时
  （ef9c928 后 settings store 已是结构化集中配置）。
- 子代理条目（`SubagentModelEntry`）目前只有 providerId/modelId/description，
  **没有推理选项**；子会话推理强制继承父会话（supervisor.ts:945 applyReasoningToModel
  用父 `reasoningEnabled`，:1043 thinkingLevel 同样用父值）。
- 传输层已预留：`SpawnModelConfig extends ModelCapabilityOverrides`
  （agent.ts:33，含 `reasoning?: 'on'|'off'`、`thinkingLevel?`），未被填充/消费。

## 阶段 A：subagent-models 条目级推理选项（先做）

1. **类型**：`SubagentModelEntry`（shared/types/assets.ts:98）新增可选
   `reasoning?: 'on' | 'off'`、`thinkingLevel?: ModelThinkingLevelOverride`。
   缺省 = 跟随父会话（对齐「不存 'follow'」惯例，llm.ts:13 注释）。
2. **纯函数（TDD）**：`pickSubagentModelRefs`（main/services/subagentModels.ts）
   透传覆盖字段到 `SubagentModelRef`。
3. **Main 解析**：`configuredSubagentModels`（agentHost.ts:624）把覆盖 merge 进
   `SpawnModelOption.config`；`isSubagentModelEntry` 校验容忍新可选字段。
4. **Worker 应用**：supervisor `createChildSession`——当 `selectedModel.reasoning`
   有值时替代父 `reasoningEnabled` 传给 `applyReasoningToModel` 与子会话
   `thinkingLevel`（:1043）；`thinkingLevel` 覆盖同理。
5. **UI**：SubagentModelsSettings 条目行加推理选择（跟随 / 开 + 档位 / 关）。

## 阶段 B：集成 enso_app

- `providers.subagent-models` 由 unavailable 改 executable：结构化 inputSchema
  （含 reasoning/thinkingLevel 字段）+ capabilityGateway handler + 覆盖测试更新
  （productCapabilityCoverage.fixture/test）。

## 阶段 C（实施结果）

- SSH 连接管理：✅ 已完成（e7aa913）——`projects.ssh-connections`(list) /
  `.remove` / `.test` 可执行（后两者 dangerous 走 ASK）；`.add` / `.update`
  有意封禁（密码不得进 Enso 上下文；改 host 可重定向存储密码）。
- `conversations.set-reasoning` / `set-thinking`：用户决定本次不放开（需新增
  gateway → 源会话命令投递通路，改动面较大，留待后续任务）。

## 验收

- `pnpm typecheck && pnpm test` 绿；biome check 干净。
- 子代理选带 `reasoning:'on'` 条目时，父会话关推理也能开思考；反之亦然。
- enso_app 能列出/修改 subagent-models（含推理字段），参数由 gateway 按 schema 校验。
