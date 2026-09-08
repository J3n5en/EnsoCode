# 共享类型规范

## 只从桶文件导入

`src/shared/types/index.ts` 是唯一出口，全仓库统一写：

```ts
import type { ModelProvider, SkillEntry } from '@shared/types';
import { IPC_CHANNELS, MODEL_API_KINDS } from '@shared/types';
```

不要写 `from '@shared/types/llm'`。新增类型文件后记得在 `index.ts` 里 `export *`。
Biome 的 `organizeImports` 会自动排序这些 export，不要手工调整顺序。

## IPC 通道常量

通道名集中在 `src/shared/types/ipc.ts` 的 `IPC_CHANNELS`，按功能分组并带注释：

```ts
export const IPC_CHANNELS = {
  // Settings persistence
  SETTINGS_READ: 'settings:read',
  // Local provider scan/import
  PROVIDERS_SCAN_LOCAL: 'providers:scan-local',
  // Instruction content (copy-on-write)
  INSTRUCTIONS_WRITE_SOURCE: 'instructions:write-source',
} as const;
```

规则：

- 命名 `<域>:<动作>`，全小写连字符；常量名 `<域>_<动作>` 全大写。
- `as const` 不能去掉，`IpcChannel` 类型依赖它推导。
- 一个通道要同时出现在三处：`IPC_CHANNELS`、`src/main/ipc/<域>.ts` 的 handler、
  `src/preload/index.ts` 的暴露方法。缺一处就是断链，见 [../main/ipc.md](../main/ipc.md)。

## 跨进程命令的解析器必须与生产端同步

`parseAgentCommand` / `parseSpawnModelConfig` 这类严格解析器用 `hasOnlyKeys` 卡字段白名单。
字段白名单、生产端构造函数、消费端读取处是**三方契约**，改一处就要全部对齐：

```
src/main/services/agentHost.ts  spawnModelConfig()   ← 生产（恒发 settingsProviderId）
src/shared/types/agent.ts       parseSpawnModelConfig ← 白名单（漏了就全部拒掉）
src/agent/supervisor.ts         settingsModelRef()   ← 消费（缺了就抛错）
```

曾经发生：生产端加了 `settingsProviderId`、消费端要求它，但白名单没加 ——
所有 spawn 命令解析返回 null，**整个 app 的会话全部起不来**，而且无日志无报错。

字段如果是消费端必需的，就在接口上写成**必填**并在解析器里强制校验，
不要留成可选；typecheck 会把遗漏的构造点（含测试夹具）全部报出来。

## 新增 AgentWorkerEvent 分支必须登记白名单

事件方向（worker→main）也有一个闭集校验器：`parseAgentWorkerEvent`，
在 `src/main/services/agentHost.ts` 的 `child.on('message')` 里把关。
它是 `switch (value.type)` + `default: return null` —— **未登记的 type 全部静默丢弃**。

给 `AgentWorkerEvent` 加一个分支时，四处都要动：

```
src/shared/types/agent.ts   AgentWorkerEvent 联合      ← 类型
src/shared/types/agent.ts   parseAgentWorkerEvent      ← 白名单（漏了事件到不了 renderer）
src/agent/supervisor.ts     this.options.emit(...)     ← 生产
src/renderer/stores/sessions/reducer.ts                ← 消费
```

曾经发生：工具实时输出 `tool-output` 事件类型加了、生产加了、消费加了、
typecheck 全绿、单测全绿，**唯独白名单没加**，运行时什么都不发生。
因为 TypeScript 管不到 `parseAgentWorkerEvent` 的分支完备性（入参是 `unknown`），
只有跑起来才暴露，而且没有任何报错或日志。

新增分支时**同时**在 `src/shared/types/agent.test.ts` 补一条往返用例
（合法事件原样通过 + 脏输入拒绝），它能在单测层就复现这个故障。

手机端（pair）是否下发是独立决定：需要的话还要进 `pairPolicy.ts` 的
`SESSION_SCOPED` 与 `guestProjection.ts` 的投影分支；不需要就在 PRD 里写成非目标。

### 配对协议（`packages/pair/src/protocol.ts`）只能加帧，不能改帧

线上 PWA 不随桌面版同步发布，新旧版本长期混跑：新能力一律“新增帧类型 + 可选字段”，
旧端按 `default` 分支静默忽略。能力类功能（如直连 `direct-v1`）由 host 在 `host-info.capabilities` 先声明，
对端看到才发起；这样旧桌面永远收不到它不认识的上行帧。上行新帧要同时登记 `PHONE_COMMAND_TYPES`
与 `pairPolicy.ts` 的字段校验（长度上限），并在 `pairPolicy.test.ts` 补往返用例。

### 给既有事件加可选字段：parser 必须校验形状，不能只放行

`turn-completed.digest?: TurnDigest` 是先例：字段可选，但**存在时形状非法要让整条事件判 null**
（`value.digest === undefined || parseTurnDigest(value.digest)`），不能 `hasOnlyKeys` 放行了事。
可选字段单独抽 `parseXxx` 导出并在 `agent.test.ts` 给「缺省合法 / 合法往返 / 形状非法整条拒」三条用例。

### 命令输入用判别联合而不是平铺字段

`summarize-title` 有两种模式（首条即时 / 每轮滚动），输入收成 `TitleSummaryInput = {kind:'initial'} | {kind:'rolling'}`
一个字段，而不是在命令上平铺 `text?` / `currentTitle?` / `userText?`。这样 `hasExactKeys` 白名单
不用随模式增减变动，renderer → preload → main IPC → worker 四层签名同一个类型，模式增加只改联合与其 parser。

## 解析失败不得静默丢弃

进程间消息入口拿不到合法命令时，**必须留下可观测痕迹**：

```ts
// Wrong：契约漂移时调用方只能等到握手超时，且没任何线索
port.on('message', (event) => {
  const command = parseAgentCommand(event.data);
  if (command) supervisor.handleCommand(command);
});

// Correct
if (!command) {
  console.warn(`[agent] dropped unparsable command: ${type}`);
  return;
}
```

同理适用于任何 `if (parsed) { ... }` 形式的边界：静默丢弃会把“契约不匹配”
伪装成“对端没响应”，排查成本差一个量级。

## 关联键只能用同一命名空间的 id

同一条链路上常常存在多个 `requestId` / `turnId`，分属不同命名空间：

| id | 由谁生成 | 含义 |
| --- | --- | --- |
| `AgentDispatchRequest.requestId` | Renderer 发起派发时 | 一次派发 |
| `CapabilityInvokeRequest.requestId` | `ensoApp` 每笔能力调用 | 一次能力调用 |
| `managed.currentTurnId` | worker 每个内部 agent turn | 一个模型循环回合 |

拿两个不同命名空间的 id 相比，条件**永远不成立**，表现是“事件静默消失”而不是报错
（曾导致完成通知的 receiptSummary 恒为空）。写关联判断前先确认两边 id 同源；
测试夹具不要图方便把它们写成同一个值，那会把真 bug 盖掉。

## 领域类型的判别式联合

多形态的数据用 `kind` 作判别式，让渲染层能在一个列表里安全地分支。
`src/shared/types/assetScan.ts` 是范例：

```ts
export interface SkillCandidate extends CandidateBase { kind: 'skill'; ... }
export interface McpCandidate extends CandidateBase { kind: 'mcp'; ... }
export interface InstructionCandidate extends CandidateBase { kind: 'instruction'; ... }
export type AssetCandidate = SkillCandidate | McpCandidate | InstructionCandidate;
```

渲染层据此收窄：`candidate.kind === 'skill' ? candidate.description : ...`
（见 `src/renderer/components/settings/LocalAssetImportDialog.tsx`）。

新增一种形态时，TypeScript 会在所有 `switch`/三元分支处报错，这是刻意的 —— 逐个补齐，
不要用 `default` 或类型断言绕过。

## 值域对齐外部 SDK

`MODEL_API_KINDS` 的取值刻意与 pi sdk 的 `Api` 对齐，方便后续直接接入：

```ts
export const MODEL_API_KINDS = [
  'openai-completions', 'openai-responses',
  'anthropic-messages', 'google-generative-ai', 'ollama',
] as const;
```

扫描到的第三方配置要经 `toApiKind()` 归一化到这个值域，
不要把外部应用的原始 type 字符串直接存进 `ModelProvider.api`
（见 `src/main/services/providerScan/readers.ts`）。

## 持久化类型的演进

以下类型会被 zustand persist 原样写进 `settings.json`，磁盘上存在用户的旧数据：

- `ModelProvider`（`providers`）
- `SkillEntry`、`McpServerEntry`、`InstructionEntry`（`skills` / `mcpServers` / `instructions`）

改这些类型时：

- **新增字段一律可选**，或在读取处兜底。例：`ModelEntry.enabled?: boolean`，
  用 `model.enabled !== false` 判断，让老数据（无该字段）默认视为启用
  （见 `src/renderer/components/settings/ProviderEditDialog.tsx` 的 `isEnabled`）。
  MCP 超时同理：`McpServerEntry.connectTimeoutSec` / `callTimeoutSec` 可选，
  经 `src/shared/mcpTimeout.ts` 归一成 spawn 毫秒；缺省仍是 10s 连接 / 120s 调用。
- **重命名字段等于丢数据**。`InstructionEntry.path` 曾改名为 `sourcePath`，
  旧条目在界面上直接变成空路径。真要改名就得写迁移，或接受旧数据失效并说明。
- 主进程也会直接读这个文件做去重比对
  （`src/main/services/assetScan/index.ts` 的 `existingKeys()`），
  字段改名要同步改那里，否则去重静默失效 —— 类型检查抓不到，因为那里是 `unknown` 断言。

## 敏感字段不进渲染层

`apiKey` 明文、MCP 的 `env` 值只存在于主进程。传给渲染层的候选类型只带脱敏信息：

```ts
export interface ScanCandidate {
  apiKeyMasked: string;   // 而不是 apiKey
}
export interface McpCandidate {
  envKeys: string[];      // 只有键名，没有值
}
```

新增扫描来源时保持这个切分，不要图省事把明文塞进候选类型。

## 子模型条目可用性契约

### Scope / Trigger

修改 `SubagentModelEntry`、子模型设置、Enso 更新能力或便携配置时都要核对；条目可用性不是推理开关。

### Signatures

`SubagentModelEntry.enabled?: boolean`；`updateSubagentModel(id, { enabled })` 只改条目。
`pickSubagentModelRefs(entries, providers)` 输出不带 disabled 条目；`reasoning?: 'on' | 'off'` 仍是独立推理覆盖。

### Contracts

缺省 enabled=true；false 保留描述和推理配置，仅移出候选。过滤必须在 provider/model 去重**之前**。
候选由 Main 在 parent spawn 时下发，已有 parent 不热更新；UI 必须简短说明新启动会话生效，不打断现有子任务。
便携 codec 的 SUBAGENT_MODEL_KEYS 必须包含 enabled；Enso 能力重建条目时不得遗漏已持久化 enabled。
推理 `off` 保留 `thinkingLevel`（再开 on 直接恢复），只有 `follow` 清空——设置页与能力网关必须同口径。

### Validation & Error Matrix

| 输入 | 行为 |
| --- | --- |
| 缺 enabled | 兼容旧数据，启用 |
| enabled=false | 不输出候选，配置原样保留 |
| enabled=true | 仍受 provider 凭证/模型行可用性约束 |
| 便携包 enabled 非布尔 | codec 拒绝，不静默转 true |

### Good / Base / Bad Cases

Good：关 A、B 继续可用，开 A 后原描述和深度仍在。Base：旧配置无 enabled 正常可用。
Bad：编辑 A 的描述后 enabled 丢失、A 悄悄重新启用；禁用的重复条目抢占后续启用条目的去重键。

### Tests Required

selector 过滤/去重，settings update→持久化→rehydrate，codec 明文/加密 roundtrip，merge/replace 导入，gateway 描述更新均需断言 enabled 与相邻配置不变。

### Wrong vs Correct

Wrong：只在 React 隐藏行，或重建 `{ id, providerId, modelId, description }` 丢掉 enabled。
Correct：保留原条目配置，Main 在生成候选列表时执行 `if (entry.enabled === false) continue`。

## 厂商短文案必须上游限长

`OauthAccount.plan` 和 `OauthUsageWindow.label` 来自厂商 JWT / 额度接口，
长度不受我们控制。渲染侧（ModelPicker 16、状态栏 24）已经截断展示，
但探测结果还会写入 sidecar 并经 IPC 下发，所以**生产这些字段的探测路径
必须走 `sanitizeOauthLabel`**（上限 `OAUTH_LABEL_MAX_LENGTH` = 32）。

新探测不要把厂商原文直接赋给 `plan` / `label`。不要再写一份截断函数，
也不要把展示截断上移成第二个事实源——渲染侧的 truncate 是布局兜底，
上游限长是写盘 / IPC 兜底，两层都留着。
