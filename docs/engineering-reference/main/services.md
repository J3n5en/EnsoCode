# services 层规范

`src/main/services/` 放不依赖 `ipcMain` 的业务逻辑。三类典型：**扫描外部应用配置**、
**对外发起网络请求**、**agent worker 的生命周期托管**（`agentHost.ts`）。

## Bot 宿主的投递边界

- `status: idle` 不是回合终态：worker 还会发送 session-meta、turn-completed。Bot 槽位、结果归属与队列只在终态结算；但中断、命令失败等路径只有 idle/failed，宿主在宽限期后兜底结算并 pump，无宿主轮次的会话回到 idle 时也要 pump，否则排队投递与并发槽永久挂起。
- deliveryId 是「某会话的一次投递」的身份，按会话去重：群聊一轮里人类/例行/委派结果的 deliveryId 只给首个投递，接力一律新生成；命中去重（`duplicate`）对群当前成员按失败写 system 条目并推进，不能当作已发出。
- 委派结果使用稳定 delegationId，worker 开始处理后确认；重启通过 jsonl 用户消息去重，不以“已入队”当作已投递。
- 委派按目标成员自身的工具、skill、MCP 执行，审批档取双方更严并持久化，嵌套/恢复沿用该审批档；readonly 父会话的子代理仍继承 workspace_write 禁用。
- Bot 停用先冻结投递，再取消委派和排队项、清路由、退订并停止调度；排队取消按 deliveryId 结算，不能清掉同会话另一项的审批计时器。

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
- **代理要在 worker 里单独装 dispatcher**：Node `fetch` 不读 `HTTP_PROXY` env，光把 env
  传进 fork 没用。两条腿缺一不可：worker 入口先 `bootstrapWorkerProxyFromEnv()` 按继承 env
  自举；main 在 `spawn` 后按 `process.env` 补发一次 `set-proxy-env`（fork 前 `ProxyConfig`
  下发的命令因 worker 不存在被丢，worker 重启同理）。`sendAgentCommand` 不检查 `workerReady`，
  凡是「worker 必须知道的状态」都应在 `spawn` 回调里重推，而不是只在状态变化时下发。

worker 侧的 `SessionSupervisor` 在 `src/agent/`（与 main/renderer/shared 平级，
只准 import `@shared` 与 pi sdk），协议类型在 `src/shared/types/agent.ts`。

⚠️ 「只准 import `@shared`」这条约束的一个后果：订阅 provider 的注册在主进程与 worker
两侧各要做一遍（worker 不注册，选到该 provider 的模型推理起不来），于是这类
**主进程 + worker 共用、渲染层碰不到**的运行时代码只能放 `src/shared/providers/`——
那是 shared 层「不碰 `node:*`」的唯一例外，理由与守卫见
[../shared/index.md](../shared/index.md)。


## ChatGPT 顺序账号池的额度权威

`oauthProviders.getOauthQuotaCoordinator()` 持有 Main 唯一额度缓存，UI 的
`getOauthAccountUsage` 和 `agentHost.selectOauthPoolAccount` 共用它。配置顺序决定首个账号，
切换后一直使用当前账号，旧账号恢复不会抢回游标。只查询需要确认的候选账号：正常数据
缓存 60 秒，未知或失败缓存 15 秒，同账号并发查询合并；未知账号先让位于已确认可用账号，
全部未知才有限降级，并在 Main 日志保留警告、UI 查询保留 error。

- 一次选号的额度查询共用 20 秒单调时钟等待预算，单次挂起也必须 bounded race；
  预算到时不启动剩余网络请求，仍扫描本地健康/封锁证据，只有没有已确认健康候选且存在
  unknown 时才带 warning 有限降级。超时本身不作为耗尽证据，不取消 UI/其它池共享查询；
  后台迟到结果仍可缓存，但必须通过原有身份、查询代际及 reset 后发起校验，迟到拒绝被处理。
- 有效窗口任一 100% 即跳过，不向 worker 下发该账号试发模型请求。最早耗尽窗口 reset
  到期后重新查证；查询失败保留其它未过期耗尽窗口，过期证据不永久封锁。
- 完整有效窗口均非耗尽才是健康证据；空窗口、坏窗口和网络错误不能解封仍有效的证据。
  模型返回的结构化硬失败截止时间独立保留，晚到的健康查询也不能清除它。
  身份或查询代际过期的结果向 UI 返回空窗口和 error；恢复查询必须在 reset 后发起，
  reset 前发起、reset 后才完成的结果不算恢复证据。
- `/wham/usage` 的全局 `allowed: false` / `limit_reached: true` 是额度证据，恢复时间只取
  真正耗尽窗口；没有明确 reset 时短暂封锁并复查。额外 credits 和未匹配目标模型的窗口
  不推导为全账号不可用，普通 429 也不作为永久耗尽证据。
- `userData/oauth-quota-state.json` 只保存 key、身份 SHA-256 摘要、耗尽窗口和有限硬失败截止
  时间；不进 settings/config sync，不保存 token、email 或展示标签。读入校验版本、文件大小、
  key、身份摘要、有限时间和窗口数量，坏文件降级为重新查询；写入采用同步临时文件+rename，
  防止并发旧快照覆盖新状态。
- 身份由本地凭证账号 ID/用户 ID 派生，不透明凭证保守按凭证摘要失效。login/logout、
  就地 Codex 导入和真实凭证删除均清除旧记录，即使缓存尚未初始化也必须清磁盘 sidecar，
  因为删除最高账号号次后 `nextAccountKey` 可能复用同 key。额度网络等待结束后，host 再次
  校验成员启用状态、模型和登录态，变更中的陈旧选号拒绝下发。
- 每次真实请求的选号带不透明 UUID receipt，worker 在 fetch/SSE/refresh 失败中回传
  当次票；恢复 boundary 的候选票不替代真实请求票。Main 在内存绑定池、key、身份摘要和
  凭证代际，仅有效绑定的失败可以更新硬封锁，旧身份的迟到失败不得封锁复用 key 的新身份。
  票不落盘、不发给 Renderer，24 小时 TTL、最多 4096 条；硬失败只更新查询代际，不撤销
  同身份其它并发模型请求的票，凭证失效才提升凭证代际。
- 全池耗尽返回最早可能恢复的额度复查时间（各账号耗尽窗口最大 reset 的最小值），
  该时间不代表自动确认恢复。

回归：`oauthQuotaCoordinator.test.ts`、`agentHost.oauthPool.test.ts`、
`oauthProviders.test.ts`。测试使用依赖注入、临时目录和假网络，不读取真实用户凭据。

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

**撤销边界只能是 child 生命周期，不能是回合结束。** `trySettle` 只收口「本次派发
任务」（发完成通知、清 active），**不得调 `terminateGeneration`**：child 会话在派发轮
结束后仍活着并继续接后续轮次，提前撤销会让第二轮起的 `enso_app` 全部返回
`not bound`（现象：第一轮添加成功、后面删除全被拒）。合法撤销点只有
`child-ended` / `child-rejected` / `worker-exited` / `releaseWindow`。

receipt 事件同理：发的是**绑定上下文的 `context.turnId`**（= 派发轮次），
不是 child 内部每轮的 uuid，否则跨 turn 的 receipt 在协调器侧关联不上。

## child 恢复由 Main 级联，双形状过渡命令有到期日

重启后 coworker/child 的恢复入口在 `agentDispatchService.restoreChildren`（parent-ready
触发，幂等键是 parent generation），渲染层零参与：sessionFile/类型/名字全部由
`persistedConversation()` 自读。两条铁律：

- **resume 类操作的防撞检查必须排除自身的持久化条目**。`usedNames` 扫盘防跨
  重启撞名，而被恢复者自己的名字必然在盘上——直接复用会自撞，恢复永远失败。
  写这类单测时夹具的 `readSettings` 必须带上被恢复者自己的持久化条目（真机
  形状），否则抓不到这类 bug（见 0e8fc11）。
- **`resume-coworker` / `dismiss-coworker` 是双形状过渡命令**：工具直雇 coworker
  （普通 SessionIdentity，不进 Main sessions 索引）的遥控通路。coworker 工具统一
  到 Main dispatch（typed child）后这两条命令应随之删除，不要在其上叠新功能。

## 对 pi 私有 API 的依赖要登记

目前有两处。第一处：`src/agent/supervisor.ts` 的 `materializeSessionFile()` 调用
`SessionManager._rewriteFile()`，并在成功重写后同步其私有 `flushed` 标记。

**为什么需要**：pi 的 `_persist` 在会话出现第一条 assistant 消息前一个字节不写
（避免留空会话文件），而纯派发的父容器按设计永远不跑主 coding 回合、永远没有
assistant 消息。不干预的后果是父会话文件从未创建，重启后 `resumeConversation`
报「会话文件已丢失」，**连带该会话下所有 child 的历史都打不开**。

**升级 pi 时必须复检这一处**。回归测试（`src/agent/sessionPersistence.test.ts`）故意包含
一条**上游行为基线断言**——“pi 当前在没有 assistant 消息时不落盘”；上游改了这个
启发式，该断言会先飘红提醒复检适配层是否还需要。

Pi 0.87.1 的 `_rewriteFile()` 不设置 `flushed`；不显式同步时，首条 assistant
会以 `wx` 创建已有文件并抛出 `EEXIST`。回归还须覆盖物化后追加首条 assistant、
重开 JSONL 后消息仍存在。只有重写成功后才能设置该标记。

第二处：`src/agent/sessionAdapter.ts` 的 `continueSessionActivity()` 调用 pi 1.0.0
私有 `_runAgentPrompt([])`。公开 API 没有不新增消息的 session 级 continue；裸
`agent.continue()` 绕过自动重试、`agent_before_settle` 与 `agent_settled`，手工补发
settled 无法恢复 OAuth 池的结算前接替。空数组启动完整活动但不追加用户任务，原任务
及已完成工具结果不重放。显式用户 retry 才复位池的 per-activity `attempted`，自动接替不复位；
池会话与通知路由在 `agent_start` 初始化，因此恢复后直接 retry 也能获得结构化失败证据。
入口要求 `session.isIdle`，压缩、branch summary 或其它活动中不允许续跑；保留原
`agent.continue()` 的上下文边界：空、仅 system 或 assistant 尾部都拒绝，不发起请求。

**升级 pi 必须复检第二处**：优先查找公开无消息继续 API；确认 `_runAgentPrompt([])`
仍接受空数组、不产生用户消息，且保留完整 post-run / before-settle / settled 生命周期。
当前 SDK 的 before-settle 位于低层 loop 结束后，`ctx.signal` 可能为空；取消由
`session.abort()` 的活动标志和 before-settle 取消守卫阻止延迟选号后的续跑，不能自行
补发结算或假定低层 `agent.signal` 覆盖整个活动。回归见 `oauthAccountPool.test.ts`
（真实 SDK + supervisor retry 分支 + 假 provider：四账号顺序、活动排除复位、工具只一次、
选号等待时取消与唯一结算）、`sessionAdapter.test.ts` 和 `supervisor.silentTurn.test.ts`。

新增此类依赖前先找公开 API；确实没有时，三件事缺一不可：

1. 封成带注释的适配函数（说清为什么需要、上游行为是什么）
2. 回归测试断言**可观测结果**（文件落盘）而不是“调用了某私有方法”
3. 在本节登记

预设仅替换开头角色段落，不替换整份系统提示词。在 `before_agent_start` 用
`replacePersonaParagraph` 匹配开头默认段落，`Available tools` 及之后的内容原样保留；
不使用 loader 的 `systemPrompt` / `systemPromptOverride`，避免绕过 pi 默认工具准则生成。
设置页默认预览也只展示 `DEFAULT_PERSONA_PROMPT`；升级 pi 时复检默认段落，匹配失败时
保留原文并追加角色描述。回归见 `systemPrompt.test.ts`、`supervisor.agentDispatch.test.ts`。
正文以 UUID 文件保存，Renderer 仅修改预设引用，Main
在设置原子落盘成功后才清理取消引用的文件，不能在 debounce 期间先删正文；回归见
`settingsPresetPrompts.test.ts`。配置导入为正文分配新 UUID，不覆盖本机同 ID 正文；旧导入
正文保留给设置备份恢复使用。

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

## Claude Code 插件

插件不拆成技能 / MCP 条目入库。设置里只存 `PluginEntry`（`name@marketplace` key + 开关），
Main 在每次 spawn 时按 key 从 `~/.claude/plugins/installed_plugins.json` 找当前安装目录并现读组件
（`claudePlugins.ts`），所以 Claude Code 升级插件后路径变化无需同步。插件跟随自己的开关，不受预设影响。

| 组件 | 去向 |
|------|------|
| skills | 追加进 `skillPaths` |
| commands | `pluginCommands` → worker `promptsOverride`，命名 `/插件:命令` |
| agents | `withPluginAgentTypes()` 以名字派生的 UUID 并入自定义子代理类型（registry、dispatch、spawn 同一口径） |
| `.mcp.json` | 并入 `mcpServers`，与已启用的同名 MCP 冲突时让位；需要 OAuth 的暂不支持 |
| hooks | `pluginHooks` → `claudeHooks.ts` 内联扩展；远程会话不下发 |

Enso 不调 pi 的 `bindExtensions`，pi 不发 `session_start`/`session_shutdown`：SessionStart 在首轮
`before_agent_start` 补跑，SessionEnd 由 supervisor 释放父会话时自行 emit。插件在配置同步中排除。

## 异步资源替换与取消

- 缓存失效比较实际有效配置；Provider 的 ID 不变，不代表端点或凭证未变，删除记录也必须失效。
- 重配、刷新和关闭都要使旧初始化失效；成功、失败及 `finally` 只允许当前任务发布状态，过期资源须释放。
- 发出 abort 不等于文件 I/O 已结束。同目录下载重启前等待旧任务收尾，不能仅删除 `running` 后立即复用 `.part`。
- 回归须挂起初始化或重试，再跨事件轮次切换、取消和重开，验证旧任务不会覆盖新配置、释放新资源或删除新任务状态。

回归位置：`src/main/services/memoryHost.test.ts`、`src/main/services/chatModels.test.ts`、`src/main/services/memoryModels.test.ts`。

## 网络请求按协议分派

`providerApi.ts` 按 `ModelApiKind` 分派 URL、请求头和请求体。约定：

- base URL 为空时用 `DEFAULT_BASE_URLS` 兜底。
- 版本段用 `withVersionSegment()` 拼接，已含 `/v1` 就不重复加。
- 统一 15 秒超时（`AbortController` + `setTimeout`，`finally` 里清 timer）。
- 错误统一转成可读字符串：`errorText()` 截断响应体到 300 字符，
  `toMessage()` 把 `AbortError` 翻译成 `Request timed out`。
- 拉模型 / 连通性测试必须走 Chromium `net.fetch`，不要用 Node `fetch`。
  部分网关（Cloudflare）会按 TLS 指纹把 undici 拦成 403 挑战页；聊天能通是因为
  worker 装了系统代理，设置页主进程直连就会挂。发请求前先 `getProxyConfig().whenReady()`。

**连通性测试会真实调用模型**（`max_tokens: 1` 的最小请求），会计费。
没指定模型时退化为拉取模型列表，只验证鉴权和连通。改动这里要保持这个代价意识。

### 模型列表鉴权兼容（不推导聊天鉴权）

- 入口：`listModels(config: ProviderApiConfig): Promise<ListModelsResult>`。
- 仅第三方 `anthropic-messages` 目录首次返回 **401** 时，在同一个已解析 URL
  以 `Authorization: Bearer` 替换 `x-api-key` 再请求一次，保留 `anthropic-version`。
  官方请求按 `URL.hostname === 'api.anthropic.com'` 判断，不按整段 URL 或子串判断。
- 所有目录请求使用 `redirect: 'manual'`；3xx、403、429、5xx、网络异常和超时不触发
  鉴权回退。不能带着密钥跟随重定向，也不能把目录兼容逻辑扩展到 `/messages`。
- 成功响应必须是对象：Anthropic/OpenAI 含 `data` 数组，Google/Ollama 含 `models`
  数组。坏 JSON、HTML、错误结构均返回 `ok: false`；合法空数组仍可成功。
  非 2xx 不读取服务端响应体；异常继续脱敏。UI 在失败时不合并模型，空列表不删除旧行。
- 回归测试见 `providerApi.test.ts`：第三方 401→200 两次且同 URL；官方 401 一次；
  401→401 最多两次；非401和 AbortError 不回退；回退后的坏响应失败；
  Google/Ollama 空数组兼容；消息请求无新增回退或 redirect 设置。
- 错误：因为消息协议是 Anthropic，就认定目录必定接受 `x-api-key`。
  正确：仅对已观察到的目录 401 做有限兼容，不猜测模型实际可调用性。

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

## browserHost：内嵌浏览器宿主

`browserHost.ts` 持有 `persist:enso[-dev]-browser` 独立 session 与 tab 表（按 agent
`sessionId` 记「当前 tab」）。worker 经 `browser-invoke` 事件调用，Main 回 `browser-result`。

- URL 门在 `@shared/browser/urlPolicy`：只放 http(s)；`will-navigate` / `will-redirect` /
  `setWindowOpenHandler` 都过同一道。
- 模型可用的 `browser_cdp` 只走 `@shared/browser/cdpPolicy.assertAllowedCdpMethod`：给调试面
  （Runtime / DOM / CSS / Profiler / Performance / Log / Network.enable），拒 `Input.*`、Cookie、
  `Page.navigate`、下载、`Target.*` / `Browser.*` / `Storage.*`。点击 / 输入 / 导航一律走专用工具，
  要放宽先改策略测试再改名单。host 自用的 CDP（截图、设备度量）不过这道门。
- 快照只收视口内可见控件（带 `kind=click|fill|select`）和可见正文，不把屏外文章推进模型。
  password 控件要进 snapshot（`kind=fill`），但**不带当前值**；file / hidden 仍排除。
- 点 / 填 / 键 / 滚 / 选 / 拖走页内脚本 DOM 事件（`@shared/browser/pageScripts`），ref 只认最近一次快照。
  点/填前 `elementFromPoint` 检查遮挡（先隐掉锁定遮罩）；被挡住返回 covered，不要当 stale 重试死 ref。
  动作后在页内等两帧或 50ms，combobox 输入最多再等 200ms 出建议。
- 拖拽不走合成 `MouseEvent`（HTML5 DnD / 部分库不认）。Main 先隐锁定遮罩，再
  页内用同一份 `DataTransfer` 发 `dragstart/dragover/drop`（原生 HTML5），然后
  `webContents.sendInputEvent` 发可信 mouseDown → 先微移 8px → 分段 mouseMove → mouseUp
  （jQuery UI 一类 mousedown 拖拽）。模型仍不能调 `Input.*`。
- 锁定两层防：页内 `PAGE_LOCK_OVERLAY_SCRIPT` 吞用户指针 + renderer 把锁定当 `covered` 让 guest 沉底，
  hover 遮罩与「接管」按钮画在 renderer（见 windows.md 层级一节）。
- 浏览器工具 `executionMode: 'sequential'`：navigate 会清 ref，并行必假 stale。
- 回合结束（`turn-completed` / `turn-failed`）关未锁且用户没在看的 tab；`parent-ended` 强关。

## 用量「按项目」不能用 cwd basename

`parseSessionJsonl` 从 session 头 `cwd` 取叶子目录名当 `project`。Enso 隔离 worktree 的路径是
`userData/worktrees/<projectId>/<8 位会话短 id>`，叶子名会变成 `3085e88f` 这类 hash，
设置页「按项目」就会把同一仓库拆成多个条目。

正确身份是**主项目名**，不是当前工作目录名：

- 解析层仍保留 basename + `cwd`（jsonl 事实）
- 归并在 `usage/projectLabel.ts`：用 settings 项目 + `worktrees.json` 按 cwd / 叶子名 / `worktrees/<projectId>/…` 映射
- `ingestSessionJsonl` 与 `getUsageSummary` 都走同一套别名，旧账本只剩短 id 也能并回去

Wrong：`project = basename(cwd)` 直接进聚合。
Correct：`usageProjectLabel(basename, cwd, aliases)` 后再 `aggregateUsage`。

## 用量解析缓存

会话目录可达 GB 级，全量解析一次要数秒。`usage/parseCache.ts` 把每个 jsonl 的解析结果按
`mtime/size` 落盘到 sessions 同级 `usage-cache/<文件名>.json`（内存再叠一层），重启后只读小缓存；
账本文件同样按 `mtime/size` 在内存复用。

- 缓存存的是**未套别名**的解析原值，别名仍在读取时套用；账本存的是套过别名的冻结值，两者不能互相替代
- `parseSessionJsonl` 输出语义变化必须递增 `CACHE_VERSION`，否则旧缓存会继续生效
- jsonl 消失时 `loadSessions` 同步清掉对应缓存文件
