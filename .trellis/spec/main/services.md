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

## browserHost：内嵌浏览器宿主

`browserHost.ts` 持有 `persist:enso[-dev]-browser` 独立 session 与 tab 表（按 agent
`sessionId` 记「当前 tab」）。worker 经 `browser-invoke` 事件调用，Main 回 `browser-result`。

- URL 门在 `@shared/browser/urlPolicy`：只放 http(s)；`will-navigate` / `will-redirect` /
  `setWindowOpenHandler` 都过同一道。
- 模型可用的 `browser_cdp` 只走 `@shared/browser/cdpPolicy.assertAllowedCdpMethod`：给调试面
  （Runtime / DOM / CSS / Profiler / Performance / Log / Network.enable），拒 `Input.*`、Cookie、
  `Page.navigate`、下载、`Target.*` / `Browser.*` / `Storage.*`。点击 / 输入 / 导航一律走专用工具，
  要放宽先改策略测试再改名单。host 自用的 CDP（截图、设备度量）不过这道门。
- 点 / 填 / 键 / 滚 / 选 / 拖走页内脚本 DOM 事件（`@shared/browser/pageScripts`），ref 只认最近一次快照。
  按坐标命中（`click_xy` / `drag`）用 `elementFromPoint` 前要先隐掉锁定遮罩，否则命中的是遮罩。
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
