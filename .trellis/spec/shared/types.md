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

## 厂商短文案必须上游限长

`OauthAccount.plan` 和 `OauthUsageWindow.label` 来自厂商 JWT / 额度接口，
长度不受我们控制。渲染侧（ModelPicker 16、状态栏 24）已经截断展示，
但探测结果还会写入 sidecar 并经 IPC 下发，所以**生产这些字段的探测路径
必须走 `sanitizeOauthLabel`**（上限 `OAUTH_LABEL_MAX_LENGTH` = 32）。

新探测不要把厂商原文直接赋给 `plan` / `label`。不要再写一份截断函数，
也不要把展示截断上移成第二个事实源——渲染侧的 truncate 是布局兜底，
上游限长是写盘 / IPC 兜底，两层都留着。
