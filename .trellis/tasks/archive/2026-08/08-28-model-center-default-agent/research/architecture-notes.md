# 调研纪要：模型中心 / 默认模型 / 内置 Enso Agent

> 只读调研。以下为仓库事实；方案见 `design.md`。
> 不纳入：`.omp/extensions/enso-subagent-guard/**`、`src/tooling/trellisSubagentGuard.test.ts`。

## 1. 提供商：三入口、一落盘

**事实**

- 设置分类 `providers` 在 `src/renderer/components/settings/SettingsContent.tsx`，三个按钮在 `ProvidersSettings.tsx`：
  - `Import from local apps` → `LocalImportDialog`
  - `Subscription login` → `OauthProvidersDialog`
  - `Add provider` → `ProviderEditDialog('new')`
- 三类都写入 `SettingsState.providers: ModelProvider[]`（`enso-settings`，`userData/settings.json`）。
- 辨别：`oauthAccountKey` = 订阅；`importedFrom` = 导入；两者皆无 = 手动 API key。
- 订阅凭证不在 settings，在 `userData/agent/pi-agent/auth.json`（`oauthProviders.ts` `authPath()`）。
- 没有声明式「提供商定义 / 引导步骤」schema。自定义与导入共用 `MODEL_API_KINDS` + 同一张表单；OAuth 能力来自 `runtime.getProviders().filter(p => p.auth.oauth)`；Antigravity / Cursor 是代码注册。

**OAuth 交互（已存在，应复用）**

- `startOauthLogin`（`src/main/services/oauthProviders.ts`）：同一时刻一个登录流；`shell.openExternal` 打开完整授权 URL；推给渲染层的 `auth_url` 只含 origin+pathname。
- 事件：`info` / `progress` / `auth_url` / `device_code` / `prompt` / `prompt-cancel` / `done` / `error`（`src/shared/types/oauthProviders.ts`）。
- 渲染层 `OauthProvidersDialog` 订阅 `onOauthLoginEvent`，`done` 时 `upsertProvider`（占位 `api: 'openai-completions'`，空 apiKey/baseUrl）。
- 列表删除订阅条目会先 `oauthLogout` 再 `removeProvider`；对话框内 Logout 只退登不删条目。

## 2. 默认模型：现在没有

**事实**

- `SettingsState`（`src/renderer/stores/settings/types.ts`）无 `defaultProviderId` / `defaultModelId`。
- `SETTINGS_VERSION = 1`，唯一迁移：`oauthProviderId` → `oauthAccountKey`。
- `newConversation` 不写 `lastProviderId` / `lastModelId`。
- `ChatView`：`lastProviderId` 仍 enabled+有凭证则用，否则 `enabledProviders[0]`；模型同理取该 provider 第一个 `enabled !== false`。
- `resumeConversation`：last 失效则静默落到「第一个 enabled+有凭证+至少一启用模型」的条目，不报错。
- 首条 `send` 才 `agent.spawn`；Main `findProvider` 按 id 取凭证，**不检查** `enabled`。
- 会话元数据 persist 在 `enso-conversations`（同 settings.json），保留 `last*`。
- **关键缺口**：`hasProviderCredentials` 对 OAuth 只做 `Boolean(oauthAccountKey)`；logout 后条目仍保留 key，因此 ChatView/resume/default 若继续用它会误判可用。
- Renderer 必须有非持久 OAuth credential snapshot（unloaded/loading/ready/error）；未 ready 对 OAuth fail-closed 且不写回默认，ready 后缺 key 才 fallback/sanitize。
- Enso/Main 不信 Renderer/provider 字段：每次 invocation 用 auth.json 真 keys 校验当前模型；create/当前模型失效的恢复/重建才按全局默认解析，默认变化不热切。

## 3. Agent 工具与审批

**事实**

- Worker 是 `utilityProcess`（`agentHost.ts`），与 Main 只走 `AgentCommand` / `AgentWorkerEvent`；worker **不能**调 IPC。
- 工具在 `supervisor.ts` spawn 时注入。只读 read/grep/find/ls 免审；bash/edit/write/MCP 走 `ApprovalGate`（`src/agent/approval.ts`）。
- `ApprovalMode`：`supervised` / `auto-edits` / `full`。`full` 全部免审。会话默认在 UI 上是 `full`（`ChatView` `approvalMode ?? 'full'`）。
- ASK 有两套：工具审批（`approval-request`）与 `ask_user`（`ask-request`）。fail-closed：abort 时 `cancelAll`。
- 渲染层决策经 `AGENT_APPROVAL_RESPOND` / `AGENT_ASK_RESPOND` 回 worker。模型输出不能直接执行 IPC。
- 设置窗 `src/renderer/settings.tsx` **没有** ChatView / sessions store；但 `registerAgentHandlers` 把 `AGENT_EVENT` 广播到 `getAllWindows()`，设置窗可以订阅。

## 4. IPC 与「可感知能力」

**事实**

- 通道全集 `src/shared/types/ipc.ts`（约 58 条），preload `electronAPI` 按域暴露，无通用 `invoke(channel)`。
- 设置 9 个 tab：General / Appearance / Providers / Presets / Agent types / Built-in tools / Skills / MCP / Instructions。**无 Team**。
- `src/**` 无团队模式实现。团队能力在 `.omp`（harness），不是应用功能。
- `settings:write` 接受整份 blob；`settings:write-key` 按顶层键合并。两者都没有字段级 schema。
- 危险面（已有）：OAuth 登录/登出、`instructions.writeSource`、`updater.quitAndInstall`、agent `full` 审批、rewind+工作树。
- 明文 `apiKey` **已经**在渲染层 `ModelProvider` 与 settings.json 里（扫描候选才脱敏）。这是既有边界，不是本任务引入的。

## 5. `@` 提及与多实体现状

**事实**

- `src/renderer/components/chat/Composer.tsx` 的 `extractMentionQuery` 只识别 `@query` 文本片段。
- 只有传入 `cwd` 时才开启提及；结果只来自 `electronAPI.files.search(cwd, query)`。
- 候选形状只有 `{ relativePath, name }`；选择后把纯文本 `@<relativePath>` 插回 textarea。
- `Composer.onSend` 只传字符串与图片，没有结构化 recipient / mention id；设置窗没有 Composer。

**已拍板产品硬契约（2026-08-28）**

| 项 | 正式值 |
| --- | --- |
| 展示名 | `Enso` |
| 提及 | `@Enso` |
| 内部稳定 Agent id | `enso` |

- `@Enso` 是 typed recipient：消息只交 **Enso 自己的独立会话**；当前编码 Agent 不参与、不继承能力。
- 来源窗口显示可点击执行卡片与结果摘要，可展开 Enso 历史。
- Enso 可从主窗与设置窗提及；`@` 候选至少区分文件与 Agent。权限与 ASK 绑定 **被 @ 的 Enso 会话** 和本次 invocation，不绑设置页。
- 危险每次 ASK，禁止 `allowSession`；只读与可逆写入免 ASK，但逐笔回显。
- 品牌名通用 ≠ 权限无限：本期仍只开放显式 capability registry。名称通用不扩大工具面。

**首期 @ 范围与发现性（Lead，验收要求）**

- 本期可提及实体只开放 `file` 与内置 `agent:enso`。底层 typed mention / registry 保留新增实体与 Agent 的扩展点，但本期不把 `@Scout` / `@Worker` / 自定义 Agent / coworker 混入提及，避免 `@` 同时暗含 hire/spawn。
- 有 Composer 的窗口：占位或辅助提示必须写明「输入 @ 选择文件或 Agent」。空查询弹层分组 `Agents` / `Files`；`Enso` 固定优先并带一句能力说明。
- 没有 Composer 的窗口：提供可见的 `Ask Enso` 入口，打开统一轻量输入并预选 `@Enso`，不要求用户猜快捷键。
- 首次可用一次性 coachmark，但不能只靠 coachmark。

## 6. 对方案的硬约束（从规范读出）


- 新 IPC 必须三点式：`IPC_CHANNELS` + `src/main/ipc/<域>.ts` + preload（`.trellis/spec/main/ipc.md`）。
- 入参当 `unknown`，返回 `{ ok, error? }`，不跨 IPC 抛。
- 改 persist 形状：`SETTINGS_VERSION +1` 且写 `migrateSettings`（`.trellis/spec/main/settings-persistence.md`）。
- 敏感数据：扫描明文只留主进程；OAuth URL 查询参数不给渲染层。
- 去重身份：API key 条目 `baseUrl+apiKey`，订阅 `oauthAccountKey`（`.trellis/spec/big-question/dedupe-identity.md`）。

## 7. 产品拍板对能力面的约束（2026-08-28，不是仓库事实）

命名、typed recipient、ASK 总则已记在 §5。本节只补 IPC/preload → registry 分级，给 Gateway 用。名称通用 ≠ 权限放开。

### 7.1 已拍板确认策略落到通道

|级别|ASK|回显|禁止|
|---|---|---|---|
|只读|免|每笔可见回显（对话里能看见查了什么）|—|
|可逆设置写入|免|每笔可见回显（改了哪一项）|不把多笔危险合并成一次同意|
|危险|**每次** ASK|ASK 摘要 + 结果一句|**禁止** `allowSession` / 「总是允许」/ 编码会话 `full` 继承|

危险（每次 ASK）：删除（provider / agent type / preset / 项目 / 对话 / 指令条目）、账号登录/退登、写密钥、开浏览器、项目文件 / 进程（含 `writeSource`、bash/写文件/MCP、雇佣 coworker、`quitAndInstall`、rewind 还原工作树）。

可逆（免 ASK，须回显）：theme / language / 快捷键 / 默认模型 / 条目与模型启用 / 内置工具开关 / agent type 与 preset 的创建与编辑（不含删）/ skills·MCP 启用 / 状态栏 / 终端外观 / `autoUpdate`。

单次用户请求里多笔可逆可合并执行，仍须逐笔回显；多笔危险仍逐项 ASK。

### 7.2 现有产品面 → 全量领域 catalog（不给模型 raw 58 IPC）

- Catalog 必须覆盖所有用户可见设置/action；每项声明 description/schema/risk/target-context/availability，并标 executable 或 known-unavailable。
- Enso 能 list/describe 全量；known-unavailable 必须说明原因与可操作下一步。内部 lifecycle/debug/transport IPC 不算产品能力。
- 安全执行仍只经 Gateway：禁止 raw IPC、通用 settings.write、任意 bash/filesystem/MCP、明文密钥。
- 团队能力纳入：global agent types；origin conversation coworkers；受控 hire/dismiss。target 来自 invocation origin，不接受模型传 sessionId。
- 无 origin、未启动/结束、超限时返回 actionable unavailable；不得静默选其它会话。
- 覆盖门禁：inventory→catalog、executable→handler 完整 Record；known-unavailable reason；SettingsState/BUILTIN_TOOLS/BUILTIN_AGENT_TYPES/相关 IPC 常量派生覆盖。非集中式新 UI action 靠 spec/checklist + reviewer 更新 inventory，不伪称自动捕获任意按钮。

Agent id 固定 `enso`；专属 worker 会话 id 在独立命名域派生。Enso create/恢复模型失效/重建只解析全局默认；无可用默认不 spawn并返回选择/添加动作；不继承来源模型、无专属模型设置。

### 7.3 ASK 宿主与 fail-closed（已被 §8 最后一项覆盖）

旧口径「来源窗口销毁即 deny」作废。权威 pending 绑定同一 `enso` 会话 + `requestId`，不属于某个窗口。来源窗关闭后请求继续挂在该会话上；其它窗口只显示非打断待确认提示，点击进入同一 Enso 历史处理原请求，不复制 ASK。fail-closed 只在：所有应用窗口关闭、Enso 会话终止、或应用退出。Main 侧单一有序队列；同一 `requestId` 只接受第一次有效响应，重复幂等忽略。编码会话 `ApprovalGate.allowSession` / `full` 不得放行 Enso 危险操作。`oauth.login` 的 `webContents` 跟当前展示同一 Enso 历史的窗口，不写死 settingsWindow。




## 8. 已拍板产品项：代码事实只作锚点

下列是产品 Key Decisions，不是仓库事实。命名 / `@` / ASK 契约不变（§5、§7）。代码只报现状，不反过来改取舍。

|产品项|决策|
|---|---|
|顶栏入口|模型中心顶栏只留独立「导入」+ 一个统一「添加模型/提供商」。进入后先选提供商，再展示订阅/API Key 方式。|
|Onboarding|Provider 主按钮复用同一向导；导入次按钮继续独立。|
|操作记录|本期不新增独立 audit；Enso 历史 + 每笔结果回显作为记录。|
|默认形状|只保存 provider entry id + model id，不含 reasoning/thinking。|
|授权 UX|授权是向导当前步骤/状态页，含动作、进度、失败恢复。|
|跨窗口 pending ASK（最后 OQ）|权威请求绑定同一 Enso 会话，Main 侧单一队列；来源窗关闭后不 fail-close、不复制 ASK；其它窗口仅非打断提示，点击进入同一 Enso 历史；`requestId` 首次有效响应生效、重复幂等；所有窗口关闭 / Enso 会话终止 / 应用退出时 fail-closed 自动拒绝。|
|全量能力与团队|Catalog 覆盖全部用户可见产品能力/设置；安全 executable 走 Gateway，known-unavailable 可描述；origin 编码会话可受控 list/hire/dismiss，危险逐次 ASK。|
|Enso 模型|首次/恢复失效/重建只用全局默认；无默认不 spawn；不继承来源、无专属设置。|
|OAuth 复用|同一宿主无关 flow/step；手动宿主是 ProviderSetupWizard，Enso 宿主是 invocation 卡/历史。|


**验收（对方案/实现，不是仓库现状）**

- 模型中心顶栏可见入口 = 「导入」+「添加模型/提供商」两条，不再并列「订阅登录」与「添加服务」。
- 统一向导第一步是选提供商；第二步只展示该提供商支持的订阅 / API Key 方式。
- Onboarding Provider 主按钮打开同一统一向导；导入仍是独立次按钮。
- 授权进行中：当前步是授权状态页（动作 / 进度 / 失败恢复），厂商列表不再同时堆授权控件。
- 全局默认 persist 只表达 provider entry id + model id；不写 `reasoningEnabled` / `thinkingLevel`。
- 无独立 audit 文件 / 通道；Enso 会话历史 + 每笔回显可核对只读与可逆操作。
- 跨窗口 pending ASK：来源执行卡显示队首确认；其它窗口只有非打断「Enso 待确认」，点击后打开同一历史处理同一 `requestId`，不出现第二份 ASK。
- 同一 `requestId` 被两个窗口先后响应：只第一次有效，第二次幂等忽略，危险动作最多一次。
- 仅关来源窗、其它窗仍在：pending 继续挂在同一 Enso 会话，不自动拒绝。
- 所有窗口关闭、终止 Enso 会话、或退出应用：未决 ASK 自动拒绝，下次启动不偷偷执行。
- Catalog 门禁覆盖完整 Record/handler/reason 与权威常量；非集中式 UI 由 checklist/reviewer 审计，不做全仓按钮扫描。
- 团队：已启动 origin 会话可在 ASK 后 hire/dismiss；无 origin/未启动/超限显示 actionable unavailable。
- Enso 模型：来源模型不同不影响；无全局默认零 spawn且有选择/添加动作。
- OAuth：手动向导与 Enso invocation 使用同一状态机，两个宿主不要求同时打开。


能力面含义（给 registry / Gateway，不扩权限）：

- 导入仍走现有 `providers.scanLocal` / `collectImport`，不进选提供商主路径。
- 统一向导里的订阅分支仍复用 `oauthLogin*`；ASK 发生在「要不要开始登录」，厂商 prompt 仍是 OAuth 事件，不是第二套窗。
- 默认模型可逆写入只改两个 id；思考档继续会话缺省 + `clampProjectThinkingLevel`。
- 不因「无 audit 文件」另开 persist 面或新 IPC。

### 8.1 代码事实（实现必须改掉的现状，不是反例）

|锚点|现状|
|---|---|
|模型中心顶栏|`ProvidersSettings.tsx:112-123` 并列三钮：`Import from local apps` / `Subscription login` / `Add provider`，分别开 `LocalImportDialog` / `OauthProvidersDialog` / `ProviderEditDialog('new')`。|
|Onboarding Provider|`Onboarding.tsx:67-75` 主按钮文案「Subscription login」→ `setOauthOpen` → **直接** `OauthProvidersDialog`；次按钮「Import from local apps」。没有「添加服务」。|
|授权 UI|`OauthProvidersDialog.tsx:230-367`：同一 DialogPanel 先铺全部可 OAuth 厂商列表（含账号 / 额度 / 行内 Logout / Add account），`busy !== null` 时在**列表下方**再堆 progress / userCode / authUrl / prompt。这正是「厂商列表下堆授权状态」。|
|默认字段|`SettingsState` 无 `defaultProviderId` / `defaultModelId`。`newConversation` 写死 `reasoningEnabled: true`, `thinkingLevel: 'medium'`（`sessions/index.ts:486-487`），与条目无关。|
|audit|`src/**` 无助手操作审计文件或通道。|
|现有 ASK 队列|worker 内 `AskManager` / `ApprovalGate` 各持 `Map<requestId, pending>`（`src/agent/ask.ts`、`approval.ts`）。`respond` 找不到 id 即 return，二次响应已是空操作。`cancelAll` 在 abort/dismiss 时 fail-closed。|
|现有 ASK 广播|`src/main/ipc/agent.ts:60-61` 把 `AGENT_EVENT` 发给 `getAllWindows()`；`AGENT_ASK_RESPOND` / `AGENT_APPROVAL_RESPOND` 任意窗都可回。渲染层 `pendingAsks` 在 `sessions/reducer.ts`，`AskBar` 只挂 `ChatView`。设置窗无 sessions store，收得到事件也画不出 ASK。|
|现有无「关一窗保活」|编码会话 ASK 绑当前 ChatView。不存在「来源窗关了、请求改挂到别的窗提示」的路径。关最后一窗 / 退出应用会拆 worker，间接触发 `cancelAll`。|


无产品反例：现状是三入口 + 列表内嵌授权，与收敛方向不一致，属于待改实现，不回驳「导入独立 / 其余归一 / 先选提供商再分支 / 授权做向导步骤」。

