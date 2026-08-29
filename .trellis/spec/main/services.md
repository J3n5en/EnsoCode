# services 层规范

`src/main/services/` 放不依赖 `ipcMain` 的业务逻辑。三类典型：**扫描外部应用配置**、
**对外发起网络请求**、**agent worker 的生命周期托管**（`agentHost.ts`）。

## agentHost：worker 生命周期与命令下发

`agentHost.ts` 托管唯一的 agent worker（`utilityProcess.fork(out/main/agent.js)`，
故障域 A：一个进程装全部活会话）。关键约束：

- **apiKey 到 Main 为止**：Renderer 发 `AgentSpawnRequest` 只带 `providerId`，
  `spawnSession` 从 settings 补全 apiKey 组装 `SpawnModelConfig` 下发 worker；
  worker 回来的事件经 `parseAgentWorkerEvent` 收窄，类型上不给 auth 位置。
- worker `exit` 时向 Renderer 广播 `worker-exited`（全部会话视为 failed），
  **不自动重启**——重启牵出 jsonl 恢复，是独立一刀。
- pi 的全局目录与会话目录经 `ENSO_AGENT_DATA_DIR` 指到 `userData/agent/`，
  不碰用户的 `~/.pi`。

worker 侧的 `SessionSupervisor` 在 `src/agent/`（与 main/renderer/shared 平级，
只准 import `@shared` 与 pi sdk），协议类型在 `src/shared/types/agent.ts`。

⚠️ 「只准 import `@shared`」这条约束的一个后果：订阅 provider 的注册在主进程与 worker
两侧各要做一遍（worker 不注册，选到该 provider 的模型推理起不来），于是这类
**主进程 + worker 共用、渲染层碰不到**的运行时代码只能放 `src/shared/providers/`——
那是 shared 层「不碰 `node:*`」的唯一例外，理由与守卫见
[../shared/index.md](../shared/index.md)。


## 能力授权以 child generation 为单位

`capabilityGateway` 的 invocation 上下文按 `generationKey(child)` 建键，
**不得把 `turnId` 叠进授权键**。理由：

- `registerCapabilityInvocation` 一次派发只调一次，代码里**没有任何“每轮重新授权”的路径**；
- worker 在 `agent_end` 会清空 `currentTurnId`，下一轮 `agent_start` 取新的随机 uuid；
- 于是 child 的活儿一旦跨了内部 agent turn，能力调用就被判 not bound，
  表现为**同一条指令时成时败**。

内部 agent turn 是模型循环产物，没有产品语义，不能当权限边界。真正的门是：

- `sameChild` 的 exact generation 比对（旧 / 伪造 generation 一律拒）
- `terminateGeneration` 的级联撤销

receipt 事件同理：发的是**绑定上下文的 `context.turnId`**（= 派发轮次），
不是 child 内部每轮的 uuid，否则跨 turn 的 receipt 在协调器侧关联不上。

## 对 pi 私有 API 的依赖要登记

目前有一处：`src/agent/supervisor.ts` 的 `materializeSessionFile()` 调用
`SessionManager._rewriteFile()`。

**为什么需要**：pi 的 `_persist` 在会话出现第一条 assistant 消息前一个字节不写
（避免留空会话文件），而纯派发的父容器按设计永远不跑主 coding 回合、永远没有
assistant 消息。不干预的后果是父会话文件从未创建，重启后 `resumeConversation`
报「会话文件已丢失」，**连带该会话下所有 child 的历史都打不开**。

**升级 pi 时必须复检这一处**。回归测试（`src/agent/sessionPersistence.test.ts`）故意包含
一条**上游行为基线断言**——“pi 当前在没有 assistant 消息时不落盘”；上游改了这个
启发式，该断言会先飘红提醒复检适配层是否还需要。

新增此类依赖前先找公开 API；确实没有时，三件事缺一不可：

1. 封成带注释的适配函数（说清为什么需要、上游行为是什么）
2. 回归测试断言**可观测结果**（文件落盘）而不是“调用了某私有方法”
3. 在本节登记

## 扫描器的三件套结构

`providerScan/` 和 `assetScan/` 都是同一套形状，新增扫描来源时照此扩展：

| 文件 | 职责 |
|------|------|
| `locations.ts` / 编排文件里的 `sourceSpec()` | 「去哪找」：各应用配置路径，含平台差异与自定义数据目录 |
| `readers.ts` / `skills.ts`、`mcp.ts`… | 「怎么读」：每种格式一个纯函数，返回归一化结构 |
| `index.ts` | 编排：遍历来源、去重标记、缓存明文、对外暴露 scan / collect |

读取器必须是**纯函数**：入参是路径，出参是归一化数组，不打印、不抛给上层。
格式解析失败就返回空数组（见 `assetScan/skills.ts` 的 `readFrontmatter`）。

单个来源出错不能让整体扫描失败 —— 编排层逐来源 try/catch，把状态记进报告：

```ts
try {
  // 读取该来源
  report.status = 'found';
} catch (error) {
  console.warn(`[AssetScan] Failed reading ${sourceId}:`, error);
  report.status = 'read-error';
}
```

## 敏感数据不出主进程

明文 API Key、MCP 的 env 值只保留在主进程的一次性缓存里：

```ts
// 仅保留最近一次扫描，供确认导入时取回完整数据（含 env 明文）
let lastScan: { scanId: string; byId: Map<string, Cached> } | null = null;
```

流程是两段式：

1. `scan()` 返回**脱敏候选**（`apiKeyMasked`、`envKeys` 只有键名）+ 一个 `scanId`
2. 用户确认后 `collect(scanId, ids)` 才从缓存里取出完整数据返回

`scanId` 不匹配就返回空数组，防止用过期的 id 捞数据。新增扫描类型时保持这个切分。

## 去重按各自的身份定义

不同资产的「同一个」含义不同，用错就会漏判或误判。当前的定义：

| 资产 | 指纹 | 为什么 |
|------|------|--------|
| 模型服务 | `baseUrl + apiKey` | 同一个端点同一把钥匙就是同一个服务 |
| 技能 | **名称**（小写） | 技能以名称调用，同名无法共存；同一技能常被多个工具各装一份到不同路径 |
| MCP 服务器 | 启动命令 + 参数，或 URL | 名字各家不同（`cunzhi` / `寸止`），命令才是身份 |
| 指令文件 | **内容 SHA-256** | 文件名相同内容各异（多家的 `AGENTS.md`），内容相同文件名各异（`CLAUDE.md` 与 `AGENTS.md` 常是同一份） |

实现在 `assetScan/index.ts` 的 `skillNameKey` / `mcpKey` / `seenInstructionHashes`。

重复项**标记而不丢弃**：候选带 `duplicated` 和 `duplicateReason`
（`registered` / `same-content` / `same-name`），界面上置灰且默认不勾选，
用户仍可手动选。三层都要拦：扫描标记、collect 批内去重、store 落库前再判一次。

## 网络请求按协议分派

`providerApi.ts` 按 `ModelApiKind` 分派 URL、请求头和请求体。约定：

- base URL 为空时用 `DEFAULT_BASE_URLS` 兜底。
- 版本段用 `withVersionSegment()` 拼接，已含 `/v1` 就不重复加。
- 统一 15 秒超时（`AbortController` + `setTimeout`，`finally` 里清 timer）。
- 错误统一转成可读字符串：`errorText()` 截断响应体到 300 字符，
  `toMessage()` 把 `AbortError` 翻译成 `Request timed out`。

**连通性测试会真实调用模型**（`max_tokens: 1` 的最小请求），会计费。
没指定模型时退化为拉取模型列表，只验证鉴权和连通。改动这里要保持这个代价意识。

## 写入校验

任何按渲染层传入的路径写文件，都必须先校验。`instructionStore.ts` 的两道：

```ts
// 1. id 只接受 uuid 形态，避免路径穿越
const isValidId = (id: string): boolean => /^[a-f0-9-]{36}$/i.test(id);

// 2. 写回源文件前，核对该路径确实是这个条目已登记的 sourcePath
function isRegisteredSource(id: string, sourcePath: string): boolean { ... }
```

没有第二道，`instructions:write-source` 就成了「渲染层可写任意文件」的通道。
新增任何写文件通道时想清楚：**攻击者控制这个参数能写到哪里**。
