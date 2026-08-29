# 统一模型配置与内置 Agent Enso

## Goal

让用户用一套可预期的流程管理模型提供商，为普通新会话指定全局默认模型，并在当前编码会话里用 typed `@Agent` **确定性派发**子代理：选中哪个 Agent 就雇佣哪个，每次发送都开一个唯一实例 TAB。品牌级 System / Built-in Agent `Enso` 固定存在，用于发现全部用户可见产品能力与设置、执行当前可用的安全领域能力，并快速为当前编码会话组建团队。Enso 对只读、可逆设置写入、危险操作分级处理；账号 / 文件 / 进程 / 团队成员变更等危险操作必须逐次询问用户。

用户价值：少记三套互不相干的添加路径；新对话不再「碰巧用到列表第一项」；用 `@Scout` / `@某自定义` / `@Enso` 直接开人，不必让主模型转交或猜收件人；设置与团队功能不必在九个分页里手工翻找，同时不能把订阅登录、退登、删配置变成静默副作用。子 Agent 的任务、回复、ASK 与历史都在它自己的 TAB；主聊天只显示派发 / 完成通知，不把原 `@` 任务交给主模型。

## Background / Confirmed Facts

下列全部来自当前仓库，不是产品决定。

### 模型中心今天有三条平行入口

设置窗「Model Providers」页顶栏并列三个按钮，分别打开三个互不共享的弹窗（`src/renderer/components/settings/ProvidersSettings.tsx:112-123`、`:272-274`）：

| 入口文案 | 打开的流程 | 做什么 |
| --- | --- | --- |
| Import from local apps | `LocalImportDialog` | 扫描本机 AI 应用 → 勾选候选 → 入库后再拉模型 / 开关模型（`LocalImportDialog.tsx:22-23,38-88`） |
| Subscription login | `OauthProvidersDialog` | 列出可 OAuth 的厂商 → 浏览器授权 / device code / 输入码 → 成功后按账号 upsert 一条 `ModelProvider`（`OauthProvidersDialog.tsx:183-188,102-128`） |
| Add provider | `ProviderEditDialog`（`provider === 'new'`） | 空白表单填 name / api / baseUrl / apiKey / 模型，可 Fetch / Test（`ProviderEditDialog.tsx:41-54`） |

首次引导的 Provider 步只有「订阅登录」主按钮 +「从本地应用导入」次按钮，没有「添加服务」（`src/renderer/components/onboarding/Onboarding.tsx:65-73`）。

列表按厂商分组：订阅条目用 `oauthAccountKey` 反解基础 providerId，API-key 条目用 `baseUrl` hostname 查表，识别不出的进 `__custom`（`src/shared/providerGroups.ts:13-14,64-85`）。订阅行主位是邮箱 / 账号 key + plan 徽标，API-key 行主位是用户起的名字 + API 类型（`ProvidersSettings.tsx:151-187`；选模菜单同口径 `ModelPicker.tsx:200-227`）。

### 授权状态怎么呈现

- 登录态权威源是 `auth.json` 的账号列表，不是布尔开关：`OauthProviderInfo.accounts` 空数组 = 未登录（`src/shared/types/oauthProviders.ts:35-38`）。
- 订阅对话框展示账号数、邮箱、plan、额度窗口；登录中用 progress / 授权页链接 / 用户码 / prompt（`OauthProvidersDialog.tsx:245-272,314-350`）。
- 主进程登录会 `shell.openExternal` 打开系统浏览器，同一时刻只允许一个登录流（`src/main/services/oauthProviders.ts:274-276,314-316`）。
- 设置列表里的订阅行**不**显示额度；额度只在订阅对话框。
- 订阅对话框里的「Log out」只调 `oauthLogout`（删 `auth.json` 凭证），**不**删除 settings 里的 `ModelProvider` 条目（`OauthProvidersDialog.tsx:196-204` vs `oauthProviders.ts:466-476`）。
- 设置列表删除订阅条目则相反：先 `oauthLogout` 成功再 `removeProvider`；退登失败会留条目并给出重试 /「仍要删除本地配置」（`ProvidersSettings.tsx:63-94,275-295`）。

可用凭证判定：`apiKey` 或 `oauthAccountKey` 任一非空（`src/shared/types/llm.ts:55-58`）。订阅条目的 `apiKey` / `baseUrl` 为空（`:48-52`）。

IPC 面：扫描 / 收集导入、拉模型、测连通、查 model meta、OAuth 列表 / 登录 / 应答 / 取消 / 重开授权页 / 登出 / 额度（`src/main/ipc/providers.ts:58-117`）。

### 新会话今天怎么选模型

**没有全局默认模型字段。** `SettingsState` 只有 `providers: ModelProvider[]`，没有 `defaultProviderId` / `defaultModelId`（`src/renderer/stores/settings/types.ts:56-57`）。

`newConversation` 只建草稿：不写 `lastProviderId` / `lastModelId`（`src/renderer/stores/sessions/index.ts:459-488`）。聊天区有效模型是：

1. 启用且有凭证的 provider 里，命中会话 `lastProviderId` 的那条，否则 **数组里第一个**（`ChatView.tsx:35-41`）
2. 该 provider 已启用模型里，命中 `lastModelId` 的那个，否则 **该条目第一个已启用模型**（`:45-48`）
3. 发送时把这个有效值交给 `agent.spawn`（`:241-252`）；首次 spawn 才把它们写进会话（`sessions/index.ts:601-625`）

因此今天的「默认」= providers 数组顺序上第一个可用条目的第一个启用模型，随导入 / 添加顺序漂移。

Resume 时若上次 provider 已删 / 禁用 / 没凭证，静默改用第一个可用条目，不报错（`sessions/index.ts:643-659`）。模型选择器对已禁用模型不可选（`ModelPicker.tsx:441-442`）。

主进程 spawn 只信任请求里的 `providerId` + `modelId`，找不到 provider 则失败（`src/main/services/agentHost.ts:72-90,362-366`）。

### 设置里今天能改什么

设置窗是独立窗口（`WINDOW_OPEN_SETTINGS`），九个分页（`SettingsContent.tsx:30-40`）：General、Appearance、Model Providers、Presets、Agent types、Built-in tools、Skills、MCP Servers、Instruction Files。

可持久化写入面（`stores/settings/types.ts:28-79`）：theme / language / 终端外观 / 状态栏段位 / `loadLocalSkills` / `autoUpdate` / `providers` / `skills` / `mcpServers` / `instructions` / `presets` / `agentTypes` / `disabledBuiltinAgentTypes` / `disabledBuiltinTools` / `onboarded` / `keybindings` / `projects`。任何窗口写入都会让其它窗口 `rehydrate`（`.trellis/spec/renderer/state.md` 多窗口同步）。

**没有**品牌级内置 Agent `Enso`。现有「Agent types」是给编码会话的 subagent 类型表（`AgentTypesSettings.tsx`；`BUILTIN_AGENT_TYPES` = scout / worker / reviewer，`src/shared/types/assets.ts:45-71`）：

- `general` 行带 Built-in badge，无删除 / 禁用控件（`AgentTypesSettings.tsx:56-67`）。
- scout / worker / reviewer 可禁用；编辑内置会生成同名自定义覆盖，覆盖后内置行隐藏（`:40-52,69-88`）。
- 关掉 `disabledBuiltinAgentTypes` / `disabledBuiltinTools` 会让对应内置类型或工具对编码会话不可用。

团队相关、已存在、可配置的软件功能：

- 子代理类型 CRUD + 内置类型开关（`agentTypes` / `disabledBuiltinAgentTypes`）
- 内置工具开关：`subagent` / `coworker` / `todo` / `ask_user` / `background_tasks`（`src/shared/types/builtinTools.ts:10-34`）
- 预设：skill + MCP + 指令组合（`PresetsSettings.tsx`）
- 编码会话里的 coworker 雇佣 / 解雇是**会话作用域**，不在设置 store 里（`sessions/index.ts` `hireCoworker` / `dismissCoworkerFromUI`）
- 聊天区已有「父会话 + 每个 coworker 一个 tab」条（`CoworkerTabs.tsx`）：tab 可切换；解雇是显式动作

主窗标题栏今天只有拖拽与窗控，没有 Enso / Ask 入口（`src/renderer/components/app/TitleBar.tsx`）。

### ASK / 审批今天能复用什么

三套现成交互，语义不同：

1. **工具审批门** `ApprovalGate`（`src/agent/approval.ts:18-33,91-106`）：按会话档位拦 `command` / `file-edit` / `file-write` / `mcp`。三档 `supervised` / `auto-edits` / `full`。决策 `allow` / `allowSession`（本会话同工具名免审）/ `deny`。fail-closed：abort 全部按取消。UI 是 composer 上方 `ApprovalBar`，只渲染队首，>1 显示 1/N；bash 显示命令全文（`ApprovalBar.tsx:49-55`）。有 pending 时输入框锁定（`ChatView.tsx:194`）。read / grep / find / ls / todo / ask_user / subagent / coworker 工具本身免审（`supervisor.ts:520-526,662-668`）。
2. **提问条** `ask_user` → `AskBar`（`src/agent/ask.ts`；`AskBar.tsx:11-24`）：问题 + 可选 2–4 个快捷选项 + 自由输入。同样队首 / 1/N。
3. **UI 二次确认** `ConfirmDialog`：删 provider / 项目 / 对话、回退还原文件等（`ProvidersSettings.tsx:275-295`；`ConfirmDialog.tsx:23-24`）。这是渲染层确认，不是 agent 工具门。

编码会话的审批档位 **缺省是 `full`（完全放行）**（`sessions/index.ts:61-62`；`ChatView.tsx:209-210`），与历史 PRD「supervised 为默认」不一致。Enso 若复用该会话档位，危险操作会被默认放行——这是硬约束冲突，不能沿用编码会话缺省。

`allowSession` 只活在当前 worker 会话内存，不跨重启。

### `@` 今天只代表项目文件

主聊天 Composer 的 `@` 只在有 `cwd` 时启用：对光标前 `@query` 做项目文件搜索，候选只有 `{ relativePath, name }`，选中后插入 `@<relativePath>`；无项目目录时不会识别 `@`（`src/renderer/components/chat/Composer.tsx:13-16,131-158,177-184,208-213`）。候选 UI 也只有文件图标、文件名与相对路径（`:325-348`）。设置窗根组件只有 `SettingsContent`，今天没有 Composer（`src/renderer/settings.tsx:8-17`）。

父会话同时存活 coworker 的硬上限是 `MAX_ORIGIN_COWORKERS = 5`（`src/main/services/agentSessionIndex.ts`）。今天未启动的父会话不能 hire；本期产品改为：未 `started` 时先只 spawn parent 容器再开 child TAB。


---

## Terms

| 术语 | 含义 |
| --- | --- |
| 提供商条目 | 一条 `ModelProvider`：订阅账号或一份 API-key 配置，可启用 / 禁用 |
| 厂商 / 提供商定义 | 分组用的 vendor（如 Anthropic、xAI）或用户自填的自定义端点；不是条目本身 |
| 导入 | 从本机其它 AI 应用扫描并入库；本期保持独立入口 |
| 订阅 | 用 OAuth / device code 登录厂商订阅，凭证进 `auth.json`，条目带 `oauthAccountKey` |
| 自定义 | 用户提供 API Key + Base URL + API 类型（含从厂商定义预填后改成自建端点） |
| 全局默认模型 | 用户指定的「提供商条目 + 模型 id」，**只**供尚未自选模型的普通新会话作为初始模型。它不是 Enso 默认，也不热切已运行的子 Agent |
| Enso | EnsoCode 品牌级 System / Built-in Agent；展示名固定 `Enso`，提及形式 `@Enso`，内部稳定 id 固定 `enso`。产品自带、固定存在：不可删除、不可禁用、不可被同名自定义覆盖，也不受 `disabledBuiltinAgentTypes` / `disabledBuiltinTools` 影响。Agent Types 只读展示它。本期能力仍受显式 catalog 约束，名称通用不等于权限无限 |
| 领域 capability catalog | 面向用户产品能力的结构化目录；覆盖全部用户可见产品能力 / 设置，每项包含稳定身份、名称、参数、风险、当前可用性与不可用原因。它不是原始 IPC 清单 |
| `@` 实体 | Composer 可选择的强类型引用。Agent 候选 = **锁定 Enso** + **未禁用内置类型**（scout / worker / reviewer）+ **合法自定义类型**（不得覆盖 `enso` / `Enso`）。另开放项目文件 `file`。旧口径「首期只有 file + Enso」作废。`general` 是父会话自己，不进入 `@` 候选 |
| typed `@Agent` / 确定性派发 | 发送时的收件人由用户选中的 `{ kind: 'agent', id }` 唯一决定。系统按该 id 雇佣一个**新的 coworker child TAB**，不让主模型挑选、改写或代答收件人 |
| recipient chip | 用户选中某个 `@Agent` 后出现在 composer 上的收件标记。一条消息恰好一个 Agent 收件人；再选另一个 Agent 会替换 chip。文件 mention 只作该收件人的上下文 |
| coworker child TAB | 一次 mention 派发生成的唯一 coworker 子实例，挂在父会话 tab 条上。承载本实例的任务、回复、ASK 与历史。每次 `@Agent` 都新建，**不复用、不切换到**已雇佣实例 |
| parent 容器 | 父编码会话尚未 `started` 时，派发先只 spawn 父会话作为容器（有模型、可挂 child TAB），**不**把原 `@` 任务交给主 coding Agent，也不开主 coding 回合 |
| 容量 | 每个已启动父会话同时存活的子 Agent 实例上限为 5。达到上限时拒绝新派发，不静默替换已运行实例 |
| 绑定模型 | Agent type 配置里显式写了的 provider entry id + model id。雇佣时优先用它 |
| 继承模型 | Agent type 未绑定模型时，在**雇佣当下**复制父会话当时的当前模型；之后父会话改选不热切该实例。Enso 没有可编辑绑定，始终按继承处理 |
| 全局召唤 | 主界面右上角持续可见的 Enso 入口。只预填 / 导航：当前聊天插入 Enso recipient chip 并 focus；设置 / Onboarding / 无聊天时切回主窗，聚焦已有普通会话或新建一条再预填 `@Enso`。不发送、不雇佣、不打开独立窗口或抽屉 |
| 只读 | 查状态、解释设置、列出可选项，不写盘、不开浏览器、不改凭证 |
| 可逆设置写入 | 改 settings.json 中可再改回去的开关 / 选项（主题、启用模型、默认模型等），不删账号、不改磁盘上的用户项目文件 |
| 危险操作 | 账号登录 / 退登、删条目、写密钥、改原指令文件、起进程、改用户项目文件、雇佣 / 解雇会话内 coworker 等不可轻易撤销或有外溢的动作 |
| ASK | 执行前阻断，把将发生的事说清楚，等用户明确同意；拒绝则不执行。危险 ASK 出现在**该子 Agent 自己的 TAB**，不是独立确认窗，也不内联进主聊天时间线 |
| 普通澄清 | 子 Agent 为补齐参数向用户提问，不是授权。出现在该实例 TAB，与危险 ASK 区分 |
| 逐笔 receipt | 每一笔可逆写入或危险操作结束后，在 **coworker child TAB** 写**完整已脱敏 receipt**：对象、旧值 → 新值与结果。不含 raw params / 密钥明文。这是 Main receipt 在子 TAB 上的投影 |
| 安全 receipt summary | 投影到父会话 custom `completed` / `failed` 通知的短摘要（做了什么、结果）。**parent 完成 / 失败通知含此 summary**。不含 raw params、不含 child transcript |
| 结构化 custom entry 通知 | 写入主聊天时间线的「已派发 / 完成 / 失败」状态行。给人看，也作为会话投影里的 custom entry。**不进入**主 coding Agent 的 LLM context。不含 child transcript、回复或 ASK。`completed` / `failed` **含安全 receipt summary** |
| `message_main` | child 在自己 TAB 里主动调用的显式消息工具。这是进入主 coding LLM context 的**唯一**自动通道；主模型不会读取 child 完整对话 |


---

## User Journeys

### J1 用订阅接入一个厂商

用户打开模型中心 → 点击唯一「添加模型 / 提供商」入口 → 先选择支持订阅的提供商 → 在统一向导里选订阅方式 → 当前步骤进入授权状态页 → 系统浏览器完成授权（可出现用户码 / 额外 prompt）→ 回来看到该账号已登录、邮箱 / plan 可见 → 对应提供商条目出现在列表且可用 → 用它发一条新对话能通。

### J2 用 API Key 接入同一或未知厂商

用户进入同一套「选提供商」引导 → 选已知厂商或「自定义」→ 走 API Key 分支（已知厂商应预填 API 类型与默认 Base URL，可改）→ 填 Key → 拉模型 / 测连通 → 保存后列表出现自定义条目（无订阅徽标，有 API 类型）→ 新对话可选该条目。

### J3 从本机应用导入

用户点独立的「导入」→ 扫描 → 勾选未重复候选 → 入库 → 为新条目拉模型并开关 → 列表出现带 `importedFrom` 来源徽标的条目。不经过订阅 / 自定义引导。

### J4 指定全局默认模型

用户在模型中心（或经 `@Enso` 改设置）从**当前可用**条目 / 已启用模型里指定默认 → 之后新建的**普通**对话在用户改选之前，选择器与首次发送都用这个组合 → 重启应用后默认仍在。这份默认只决定普通新会话的初始模型；不成为 Enso 或任何子 Agent 的独立模型来源，也不改写已运行实例。

### J5 默认模型变得不可用

用户删除该条目、关掉该条目、关掉该模型、或订阅退登导致条目不再有凭证 → 全局默认自动切到仍可用的第一条目的第一个已启用模型并写回；设置页提示旧值 → 新值。没有任何可用模型时清空默认，新对话选择器为空、发送被挡住。已记住模型的旧编码对话不变；已运行的子 Agent 实例不因这次回退而换模。

父会话仍有可用模型时可以继续 `@Agent` / `@Enso`；父会话模型也失效、或召唤时只能新建且尚无全局默认时，与普通聊天一样停在选模空态，不能另走一条「Enso 默认」或静默改用 providers 数组第一项。

### J6 用 typed `@Agent` 确定性派发自定义或内置 Agent

用户在已有可用模型的编码会话看到「输入 @ 选择文件或 Agent」→ 输入 `@` 后候选按 Agents / Files 分组：锁定的 `Enso` 固定优先，其后是未禁用内置类型与合法自定义类型 → 选中 `@Scout` 或 `@某自定义` 后 composer 出现对应 recipient chip → 写下任务并发送。

系统按 chip 的稳定 id **确定性雇佣**一个新的 coworker child TAB。父会话尚未 `started` 时，先只 spawn parent 容器，再开 child TAB；已启动则直接开 child TAB。任务、回复、ASK 与历史都在这个 child TAB。主聊天只插入**不入 LLM context** 的结构化 custom entry「已派发」通知；主 coding Agent 不收到原任务、不产生这条回复、不读 child transcript。绑定了可用模型的自定义类型用绑定模型；未绑定的内置 / 自定义类型 / Enso 继承**发送当时**父会话的当前模型。

同一父会话再次 `@` 同一类型，即使该类型已有存活实例：再开一个新 coworker child TAB，不切换到旧实例，不把新任务追加进旧 TAB。

### J7 在子 Agent TAB 改可逆设置或做危险操作

用户 `@Enso` 说「把主题改成暗色 / 把默认模型换成 X / 关掉 coworker 工具」→ 新 Enso TAB 处理该任务，可逆写入免 ASK；回复与**完整已脱敏 receipt** 写在 **Enso TAB**；设置页立刻看到变化；主聊天 `completed` custom entry 带**安全 receipt summary**，不含 raw params / child transcript。

用户 `@Enso` 要求「退出这个 Anthropic 账号 / 删掉这条 provider / 登录 SuperGrok」→ Enso TAB 对每项危险操作逐次 ASK，摘要写清会删凭证还是只删本地条目、会不会开浏览器 → 用户同意才调用现有登录 / 退登 / 删除流程 → 拒绝则完全不改。ASK、结果与完整已脱敏 receipt 都在 Enso TAB；主聊天 `completed` / `failed` 通知只带安全 receipt summary。不得另开一套登录窗、Enso 窗或抽屉，也不得把回复或 raw params 内联进主时间线。

### J8 从当前父会话 `@Enso` 快速组团队

用户在当前编码会话说「`@Enso` 给这个任务组一个团队」→ 若父尚未 `started`，先只 spawn parent 容器再开 Enso child TAB；已启动则直接开新 Enso TAB。Enso 读取可用 agent types / 容量与会话状态，先给出团队方案（成员、类型、用途、目标就是本父会话、风险 / 不可用原因）→ 用户在 Enso TAB 逐次确认危险的 hire / dismiss → Enso 调用现有领域能力在**当前父会话**实际雇佣 / 解雇 → 新成员以 coworker child TAB 出现在同一 tab 条，逐成员真实结果写在 Enso TAB。主编码 Agent 不负责转交。

父会话不存在或已结束：不雇佣、不声称完成、不改去另一个会话；用户看到原因和下一步（先打开 / 先恢复该会话）。父会话存在但尚未 `started`：先只 spawn parent 容器，再在 Enso child TAB 上处理组队。容量已满：拒绝新雇佣，说明需先结束或解雇一个实例。

### J9 询问软件全部能力

用户问「`@Enso 你能做什么 / 这个软件有哪些能力`」→ Enso TAB 从领域 capability catalog 列出全部用户可见产品能力与设置，能按模块筛选；每项说明参数、风险级别、当前是否可用及不可用原因。安全且已注册的能力可以直接执行；危险能力在 Enso TAB 逐次 ASK；没有注册执行器的能力只说明 / 导航，不伪造成功。主聊天只有派发 / 完成通知。

### J10 全局召唤只预填 / 导航

- 主聊天已打开：点右上角全局召唤或聊天内 Enso 入口 → 当前 composer 插入 Enso recipient chip 并 focus。不换会话、不发送、不立刻开 TAB。
- 设置 / Onboarding：同一入口把用户切回主窗；有普通会话则聚焦它并预填 `@Enso`；没有则新建一条普通会话（有全局默认则用它作初始模型，没有则选模空态）再预填。
- 用户发送之后才走 J6 / J7 的确定性派发。全程没有全局 Enso 窗口、抽屉、独立 Enso session 或 snapshot。

### J11 派发失败：无可用模型 / 容量已满 / 父会话已结束

- **无可用模型**：父会话选模空态，或目标 Agent 的绑定模型已不可用 → 不创建 child TAB、不发送给主模型；用户看到原因和下一步（先选 / 先添加可用模型）。不回退到 Enso 默认或数组第一项。
- **容量已满**：该父会话已有 5 个存活 coworker 实例 → 新的 `@Agent` 被拒绝，说明需先结束或解雇一个；已运行实例不被替换。
- **父会话尚未 `started`**：不是失败。先只 spawn parent 容器，再开新的 coworker child TAB；原 `@` 任务仍不交给主 coding Agent。
- **父会话不存在或已结束**：拒绝雇佣，说明先打开 / 先恢复该会话；不假装已开 TAB，不改去其它会话，不另开全局 Enso session。

### J12 父会话中途改模型

用户先 `@Scout`（未绑定）开出一个实例，再把父会话从模型 N 改成模型 P → 已运行的 Scout TAB 继续用 N。下一次再 `@Scout` 或 `@Enso` 的新实例用 P。绑定了模型 M 的自定义类型始终用 M（M 仍可用时），不因父会话改选而变化。


---

## Requirements

### R1 导入保持独立入口

「从本地应用导入」继续作为与订阅 / 自定义分开的入口。不把扫描流程嵌进「选提供商」引导的主路径。Onboarding 的导入次按钮若仍存在，应对同一套导入弹窗，不新造第三条导入实现。

### R2 订阅与自定义共用唯一「添加模型 / 提供商」入口

模型中心顶栏只保留两个一级入口：

1. 独立「导入」：继续走 R1 本机扫描。
2. 一个统一「添加模型 / 提供商」：进入后先选提供商，再展示该提供商支持的接入方式（订阅、API Key 或两者）。

不再在顶栏并列「订阅登录」「添加服务」。当前仓库仍是 Import / Subscription login / Add provider 三按钮并分别打开三个弹窗（`ProvidersSettings.tsx:112-123,272-274`），这是实现差距，不是保留理由。

统一向导至少满足：

- 第一步选择提供商（含「自定义 / 其它端点」）；第二步才展示该提供商可用的订阅 / API Key 方式。
- 该提供商支持订阅：复用现有浏览器 OAuth / device code / prompt，不新做登录窗。
- 授权的动作、进度、用户码、授权链接、补充 prompt、失败与重试必须成为**向导当前步骤 / 状态页**；不得继续像今天 `OauthProvidersDialog.tsx:314+` 那样堆在厂商列表下方。
- API Key 分支：已知提供商预填 API 类型与默认 Base URL（用户可改）；自定义提供商保留今天的自由表单能力（名称、`MODEL_API_KINDS` 五种 API 类型、Base URL、API Key、拉模型、测连通、模型开关）。
- 同一厂商允许多账号订阅时仍走「添加账号」，不得覆盖其它已登录账号（现状：`handleLogin` 总是新增，`OauthProvidersDialog.tsx:183`）。
- 登录成功、保存 API 配置后，条目进入同一模型中心列表，分组与选模菜单口径保持现状（订阅看邮箱 / plan，自定义看名称 / API）。

当前 OAuth 名单来自 `listOauthProviders`，API 配置来自 `MODEL_API_KINDS` + 自由表单，仓库尚无统一 provider definition schema；这是规划实现需要补齐的事实，不改变唯一入口与提供商驱动交互。

### R3 授权与条目状态可核对

模型中心列表对每条可见：启用状态、订阅 vs API-key、订阅身份（邮箱或账号 key）与 plan（有则显示）、自定义的 API 类型、导入来源徽标、模型数量。订阅的额度细节可继续放在订阅 / 账号详情里，不强制搬到每一行。

退登与删条目的差异必须可感知：对话框退登清凭证；列表删除订阅条目会连带退登（失败则留下条目前给出错）。Enso 若执行这两类操作，摘要必须用同一口径，避免用户以为「退出」等于「列表里消失」或反过来。

### R4 全局默认模型

用户可以指定一对「提供商条目 id + 模型 id」作为全局默认。候选仅限：条目已启用、具备凭证、该模型未禁用。设置页要有与聊天区选模同口径的选择器（厂商分组 + 条目 + 模型），避免用户学两套名字。

默认模型只保存 provider entry id + model id，不绑定 `reasoningEnabled` / `thinkingLevel`。默认跨重启保留。

全局默认**只**决定尚未自选模型的普通新会话初始模型。它不成为 Enso 或任何子 Agent 的独立默认，也不在 Agent Types 里给 Enso 提供可编辑绑定。`Enso` 可以把「修改全局默认」当作可逆设置执行（免 ASK、在自己的实例 TAB 逐笔回显）；那改的是普通新会话的初始模型，不是给已运行实例换模。

### R5 新会话用全局默认；子 Agent 在雇佣当下解析模型

尚未自选模型的新编码对话：选择器展示默认组合；用户不改直接发送时，使用默认组合，而不是 providers 数组第一项。用户在该对话里改选后，只影响该对话，不改全局默认。

已启动或已记住模型的编码对话不被全局默认改写。Agent types 里显式绑定的模型不被全局默认改写。

`@Agent` 雇佣时的模型解析顺序：

1. 该 Agent type **配置了绑定模型**且该组合当前可用 → 实例使用绑定模型。
2. 未绑定，或 Enso（永远未绑定）→ 实例继承**雇佣当下**父会话的当前 provider / model。
3. 父会话当前模型不可用、或绑定模型已不可用 → 不雇佣，走 R7 空态 / 错误，不回退到全局默认、Enso 默认或 providers 数组第一项。

用户之后改选父会话模型，**只影响之后新雇佣的未绑定实例**，不热切已运行子 Agent。已运行实例保持雇佣当下解析到的模型，直到该实例结束。

从设置 / Onboarding / 无聊天处召唤 Enso：只聚焦或创建普通主聊天（创建时才用全局默认作初始模型）并预填 `@Enso`，不在召唤时雇佣。没有全局默认则进入普通新会话选模空态；选出可用模型之前 `@Agent` 不能派发成功。父会话有可用模型但尚未 `started` 时，发送 `@Agent` 先只 spawn parent 容器，再开 child TAB。

### R6 默认失效必须自动回退并明确提示

当默认指向的条目被删、被禁用、失去凭证（含订阅退登后条目还在但 `hasProviderCredentials` 为假）、或模型被禁用 / 从条目中删除时，禁止继续把该组合当成可发送的默认。

已拍板策略（见 Key Decisions）：

- 自动切到「仍可用的第一条目的第一个已启用模型」，**并把新值写回全局默认**。
- 设置页给出可见说明，写清旧值 → 新值（哪一条目 / 哪一模型失效、改成了什么）。不能只在发送失败时才暴露。
- 没有任何可用模型时：清空全局默认；新对话选择器为空；发送被挡住（与今天 `!provider || !effectiveModelId` 不发送一致）。
- 不改已经记住模型的旧对话（有 `lastProviderId` / `lastModelId` 的会话，含已启动与未启动草稿）。
- 不改已运行子 Agent 的模型。
- Enso 不因此获得另一套默认；未绑定的新雇佣只看父会话当时是否有可用模型，否则与该会话一起停在选模空态。

### R7 typed `@Agent` 确定性派发，每次新 TAB / 唯一实例

产品提供可提及的 Agent，并以 typed mention 决定收件人。展示名可以本地化，内部稳定 id 与展示名必须分离：以后改展示文案不能让历史、权限、路由或 mention 失效。

**Enso 固定存在。** 展示名固定 `Enso`，提及 `@Enso`，内部稳定 id 固定 `enso`。用户不能删除、不能禁用、不能用同名自定义 Agent type 覆盖。关闭 `disabledBuiltinAgentTypes` 或 `disabledBuiltinTools` 不得隐藏或停用 Enso。Agent Types 列表必须只读展示锁定的 Built-in / System badge，没有删除、禁用、编辑模型、编辑提示或另存同名覆盖的控件。

**可提及集合（旧口径「首期只有 file + Enso」作废）：**

- 始终锁定：`agent:enso`。
- 未禁用的内置类型：scout / worker / reviewer（被 `disabledBuiltinAgentTypes` 关掉的不出现）。
- 合法自定义 Agent type：用户自定义条目；`name` / 稳定 id 不得覆盖 `enso` / `Enso`。
- 当前项目文件 `file`（只作上下文，不是收件人）。
- 不出现 `general`，避免把自己雇佣成自己。

有 Composer 的窗口必须主动提示功能：占位或辅助提示写「输入 @ 选择文件或 Agent」；空查询弹层分组显示 `Agents` / `Files`，`Enso` 固定优先并带一句能力说明；支持键盘选择、分组 / 图标 / 类型标签。没有项目 `cwd` 时 Files 可为空，Agent 仍可用。一次性 coachmark 可以有，但不能是唯一发现路径。

选中 Agent 后保留 `agent` 类型与稳定 id；不能退化成一段仅靠显示名解析的普通文本。一条消息恰好一个 Agent 收件人；再选另一个 Agent 替换 chip。文件 mention 只作该收件人的只读上下文。

**路由硬契约：typed mention 决定本条收件人，系统确定性派发。**

- 发送后按 recipient id 雇佣对应 Agent，开一个**新的 coworker child TAB**。即使同类型已有存活实例，也不复用、不切换过去、不把新任务追加进旧 TAB。旧 PM「已雇佣则切换」作废。
- 父会话尚未 `started`：先只 spawn parent 容器，再开 child TAB。父容器不跑主 coding 回合，不把原 `@` 任务交给主模型。
- 本条用户消息**不是**主编码 Agent 的输入。主模型不产生这一条的回复，不改写收件人，不读 child transcript。
- 主聊天插入结构化 custom entry「已派发 / 完成 / 失败」通知。`completed` / `failed` **只带安全 receipt summary**（不带 raw params / child transcript）。这些 entry **不进入**主 coding LLM context。进入主 LLM context 的唯一自动通道是 child 主动调用的 `message_main`。任务正文、回复、普通澄清、危险 ASK、**完整已脱敏 receipt**、团队结果都在该 child TAB。
- 需要明确目标的领域能力（如 hire / dismiss coworker）以**当前父会话**为唯一 target；用户不能让 Enso 改去另一个会话。
- **没有**全局 Enso drawer、全局 Enso session 或全局 Enso snapshot。每个 Enso 都是当前父会话下的 coworker child TAB。

**入口合同：**

- 保留主界面右上角全局召唤。它只预填 / 导航，绝不打开 Enso 独立窗口或抽屉，也不在点击时雇佣。
- 当前聊天内点击同一入口：插入 Enso recipient chip 并 focus composer，不换会话、不发送。
- 设置窗 / Onboarding 的同一入口：切回主窗，聚焦当前普通会话并预填；无会话则按 R5 创建普通会话。没有 Composer 的窗口用同一语义的 `Ask Enso`，不得另造独立输入、独立路由或独立历史。


**派发失败必须可操作，且不把原任务交给主模型：**

- **父会话尚未 `started`**：不是失败。先只 spawn parent 容器，再开 child TAB。
- **父会话不存在或已结束**：拒绝雇佣；说明先打开 / 先恢复该会话。
- **无可用模型**：父会话选模空态，或绑定模型不可用 → 拒绝雇佣；说明先选 / 先添加可用模型。
- **容量已满**：该父会话已有 5 个存活 coworker 实例 → 拒绝新派发；说明先结束或解雇一个。已运行实例不被挤掉。
- 以上失败都停在主聊天的可见错误 / 通知，不创建空 TAB 冒充成功，不另开全局 Enso session / drawer / snapshot。

### R8 Enso 能力分级与执行边界

领域 capability catalog 覆盖**全部用户可见产品能力与设置**，而不是挑一部分设置，也不是把主进程原始 IPC 逐条暴露给模型。每项至少提供：稳定 capability id、用户可读名称 / 说明、参数合同、风险级别、当前可用性、不可用原因，以及可选的领域执行 / 导航目标。

Enso 对 catalog 能力分三级：

- **只读免 ASK**：列出 / 查询产品能力、设置、状态、账号公开字段、会话 / 团队现状；结果在 Enso child TAB 正常显示。
- **可逆领域写入免 ASK、逐笔可见回显**：主题、全局默认模型、启用 / 禁用 provider 或模型、内置工具开关、创建 / 修改（非 Enso 的）agent type 与 preset 等可再改回去且不删除外部资源的产品操作。每笔在 Enso TAB 写**完整已脱敏 receipt**（对象、旧值 → 新值与结果）。主聊天 `completed` 通知投影**安全 receipt summary**。关掉 coworker 等内置工具不得连带关掉 Enso。
- **危险领域操作每次 ASK**：删除条目 / 类型 / preset / 项目 / 对话、OAuth 登录 / 退登、受保护的密钥写入、开系统浏览器、覆盖源指令文件、停止用户可见后台任务 / 进程、在当前编码会话 hire / dismiss coworker 等。每一项单独确认，禁止 `allowSession` /「本会话总是允许」。同意后同样在 Enso TAB 写完整已脱敏 receipt，主通知只带安全 summary。

安全且可执行的能力应真正调用；当前不可用或尚无执行路径时必须说明原因并给出可操作导航，不能伪造完成。需要补参数时走普通澄清，不是危险 ASK。

禁止：向 Enso / 模型暴露 raw IPC、任意文件系统 / git / shell 命令、任意 MCP 调用面、API Key 或 access / refresh token 明文。密钥写入必须通过受保护的产品能力与专门输入面完成，模型只看掩码 / 引用。通用品牌名不扩大这些权限。完整 receipt 与安全 summary 都必须已脱敏。

编码子 Agent（scout / worker / reviewer / 自定义类型）继续使用各自实例的编码工具与该实例自己的审批档位；它们不获得 Enso 的领域 catalog。本期不改编码会话的 `full` 缺省。

### R9 ASK 不复用编码会话的 `full` 缺省

Enso 危险操作的 ASK 必须阻断执行，并出现在**该 Enso coworker child TAB**。摘要写清：对象（哪条账号 / 哪条设置）、动作（登录 / 退登 / 删除 / 覆盖）、后果（凭证是否删除、其它账号是否保留）。用户可同意、拒绝；拒绝后状态与 ASK 前一致。

当前父会话即使是 `Full access`，也不能让 Enso 跳过 ASK；主编码 Agent 不能代答。禁止任何 Enso 危险操作的 `allowSession` / 总是允许。

一次展示队首、多件显示 1/N、未决期间不能继续执行下一项危险操作。用户若在设置 / Onboarding，应被切回这个 Enso TAB 处理 ASK，不复制第二份确认。同一个确认只接受第一次有效决策；重复或过期响应必须忽略，不重复执行。应用退出、父会话结束、该实例被解雇或用户关闭该对话时，全部未决 ASK fail-closed 自动拒绝，不在下次启动后偷偷执行。

OAuth 登录过程中厂商自己的 prompt（输入码、选账号）继续走统一向导当前授权步骤，不算本需求的 ASK；逐次 ASK 发生在「要不要开始登录 / 退登」这一层。从 `@Enso` 发起登录时，ASK 与「已打开系统浏览器 / 需要用户码」等状态写在 Enso TAB，仍不得另开第二套授权窗。

### R10 子 Agent TAB 是任务面；主聊天只通知

每次确定性派发的任务、回复、普通澄清、危险 ASK、**完整已脱敏 receipt**、团队结果与该实例历史都写在**这个唯一 coworker child TAB**。只读结果正常显示；可逆写入按 R8 **逐笔**写完整已脱敏 receipt；危险操作显示 ASK 及最终决策与 receipt。实际写入后，设置窗已打开的分页应立刻反映。

主聊天时间线插入结构化 custom entry「已派发 / 完成 / 失败」通知，给人核对「已经交给谁 / 是否结束」。`completed` / `failed` **投影安全 receipt summary**（保留 Main receipts 到主通知）。这些 custom entry **不进入**主 coding LLM context，也不含 raw params 或 child transcript。主编码 Agent **不读取** child transcript。进入主 LLM context 的唯一自动通道是 child 主动调用的 `message_main`。原 `@` 任务正文、child 回合、ASK 与完整 receipt 都不进入主模型后续 context。

没有全局 Enso 窗口、抽屉、独立 Enso session 或 snapshot。重启后打开同一父会话，仍能切到未销毁的 coworker child TAB 并看到此前回复与完整已脱敏 receipt。本期操作记录就是各 child TAB 的完整 receipt + 主通知上的安全 summary，不新增独立 audit 文件。

其它窗口不得再维护一份「Enso 待确认 / Enso 历史」；它们最多把用户送回对应 child TAB。操作结束后 Enso 要在自己的 TAB 明确回复成功改了哪一项、失败原因或用户拒绝。所有未决 ASK 因退出 / 会话结束 / 实例结束被自动拒绝时，该 TAB 明确显示已拒绝 / 已取消。

### R11 全部产品能力目录与团队执行

Enso 必须能从领域 capability catalog 感知全部用户可见产品能力 / 设置，至少覆盖当前九个设置分页、模型与账号管理、项目 / 对话操作、预设、agent types、内置工具、skill / MCP / 指令、更新、快捷键、subagent / coworker / 后台任务等用户能在产品里看到的能力。

用户询问能力时，Enso 能按领域列出：能力名称、用途、参数、风险、当前可用性、不可用原因。catalog 有新能力时应可扩展，不要求修改 Enso 展示名或写死一份清单。

安全且可执行的能力应按 R8 执行；危险能力逐次 ASK；只有导航 / 说明的能力必须如实标明。

**快速组团队是本期必须可执行的能力，且只 target 当前父会话：**

- 从当前编码会话 `@Enso` 时，目标就是本父会话（尚未 `started` 则先 spawn parent 容器）；Enso 基于可用 agent types、容量与会话状态列出团队方案。
- 方案至少说明拟 hire / dismiss 的成员、类型、用途、目标当前会话、风险与不可用原因。
- hire / dismiss 属危险操作，用户确认后 Enso 调用现有领域能力实际修改当前父会话；新成员以唯一 coworker child TAB 出现在同一 tab 条；逐成员回显成功 / 失败与完整已脱敏 receipt，不得只给建议。主通知只带安全 receipt summary。
- 无当前会话、当前会话已结束、达到 5 个存活实例上限、目标类型不可用或已禁用时，Enso 说明具体原因并提供下一步，不伪造已完成，不改去另一个会话，不挤掉已运行实例。尚未 `started` 的当前会话先 spawn parent 容器再执行组队。

用户也可以不经过 Enso、直接 `@Scout` / `@Worker` / `@某自定义` 派发；规则与 J6 / R7 相同，容量与 parent 容器约束相同。


---

## Acceptance Criteria

每条映射到需求；核对的是用户能看见 / 完成的结果，不是实现细节。

- [ ] **AC1（R1）** 模型中心仍能从独立「导入」入口走完：扫描 → 勾选 → 入库 → 拉模型。该入口不要求先选厂商。导入后的条目带原来的来源徽标，可在选模菜单里用。
- [ ] **AC2（R2）** 用户不填空白 API 表单也能开始订阅：先选一个支持订阅的厂商，再完成现有浏览器授权；回来后列表出现该账号条目，邮箱或账号 key 可见；用该条目新建对话能发出去。
- [ ] **AC3（R2）** 用户选已知厂商走 API Key 分支时，不必从零猜 API 类型 / Base URL（有预填且可改）；选「自定义」时仍能填任意 Base URL 与五种 API 类型之一、拉模型、测连通、保存。保存后列表按自定义条目展示（钥匙图标、API 类型，无订阅徽标）。
- [ ] **AC4（R2）** 模型中心顶栏只有独立「导入」与一个统一「添加模型 / 提供商」入口，不再并列「订阅登录 / 添加服务」。统一添加先选提供商，再展示该提供商支持的订阅 / API Key 方式；订阅与 API 配置不再各自维护一套选厂商 UI。
- [ ] **AC5（R3）** 同一厂商两个订阅账号在列表与选模菜单里能区分（不同邮箱或不同 key）；删其中一个时确认文案写明只退登该账号、其它账号保留；确认后另一个账号仍可用来对话。
- [ ] **AC6（R3）** 在统一向导 / 账号详情中点某账号「退出登录」后：`auth.json` 不再有该账号，但若条目仍留在列表，该条目不能再作为可发送目标（无凭证）；用户能看出已退出。仅删列表条目且退登成功：列表不再有该条，选模菜单也不再有。
- [ ] **AC7（R4, R5）** 设置里把默认模型设为条目 A 的模型 M 并重启后：新建对话的选择器显示 A + M；用户不改选直接发送，实际请求的是 A + M，而不是 providers 数组第一项。
- [ ] **AC8（R5）** 在该新对话里改选到条目 B 后，只有该对话变 B；下一个新建对话仍是默认 A + M。全局默认本身不变。该对话之后新雇佣的未绑定子 Agent（含 Enso）使用 B；改选前已在跑的实例不热切到 B。
- [ ] **AC9（R5）** 已有记住模型的旧对话，改全局默认后再次打开，选择器仍显示它自己记住的组合（若仍可用）。在该旧对话派发未绑定 `@Agent` / `@Enso` 时，新实例继承该对话自己的当前模型，不用新的全局默认。绑定了模型的自定义类型仍用自己的绑定模型。
- [ ] **AC10（R6）** 把默认设为条目 A 的模型 M 后，删除 A、禁用 A、关掉 M、或让 A 失去凭证：全局默认变为当时仍可用的第一条目的第一个已启用模型（写回）；设置页能看到「A / M → 新条目 / 新模型」的说明；紧接着新建的对话选择器与首次发送都用新默认，不是失效的 A + M。已记住模型的旧对话选择器不变；已运行子 Agent 不换模。若当时没有任何可用模型：默认被清空，新对话选择器为空，发送发不出去。不会出现另一套 Enso 默认。
- [ ] **AC11（R7, J6）** 有 Composer 的窗口持续显示「输入 @ 选择文件或 Agent」提示；输入空 `@` 后弹层按 `Agents` / `Files` 分组，锁定的 `Enso` 固定在 Agent 组首位并有能力说明，其后能看到未禁用内置类型与合法自定义类型。禁用 scout 后 `@` 候选不再出现 Scout，Enso 仍在。名为 `enso` / `Enso` 的自定义不出现。无项目 `cwd` 时仍可选 Agent。选中后 composer 出现对应 recipient chip。一次性 coachmark 不能是唯一入口。旧口径「只有 file + Enso」不成立。
- [ ] **AC12（R5, R7, J6）** 用户给自定义类型绑定可用模型 M，在父会话（当前模型是 N）发送 `@该自定义 做 X`：新 coworker child TAB 出现且任务在该 TAB；该实例实际请求的是 M，不是 N，也不是全局默认。
- [ ] **AC13（R5, R7, J6）** 用户在父会话（当前模型是 N）发送 `@Scout 做 X`（Scout 未绑定模型）：新 coworker child TAB 出现；该实例实际请求的是 N。
- [ ] **AC14（R5, R7）** 同一父会话（当前模型是 N）发送 `@Enso 做 X`：新 Enso coworker child TAB 出现；该实例实际请求的是 N。Agent Types 里没有给 Enso 编辑模型的控件。没有全局 Enso session / snapshot。
- [ ] **AC15（R7, R10, J6）** 发送「`@Scout 做 X`」或「`@Enso 做 X`」后：主编码 Agent 不产生这一条回复；主 LLM context 不含原任务正文，也不含 child transcript；主时间线只有不入 LLM context 的结构化 custom entry「已派发」通知。X 的正文出现在新 child TAB，不内联进主时间线。
- [ ] **AC16（R7, R10）** 子 Agent 完成后，主时间线出现不入 LLM context 的结构化 custom entry「完成」通知，并带**安全 receipt summary**（无 raw params、无 child transcript）。完整已脱敏 receipt 只在该 child TAB。失败时主时间线出现带安全 summary 的「失败」通知，原因与完整 receipt 在该 TAB。未调用 `message_main` 时，主 LLM context 仍不含该 TAB 对话，也不含这条通知。
- [ ] **AC17（R7, J6）** 同一父会话连续两次 `@Enso`（或两次 `@Scout`），即使第一次实例仍存活：出现两个不同 coworker child TAB；第二次不切换到第一个 TAB，也不把任务追加进去。没有「已雇佣则切换」行为。
- [ ] **AC18（R5, R7, J12）** 先派发一个未绑定实例（用模型 N），再把父会话改成模型 P：已运行 TAB 仍用 N；下一次未绑定 `@Scout` / `@Enso` 的新实例用 P。绑定模型 M 的自定义类型两次都用 M。
- [ ] **AC19（R5, R7, J11）** 父会话处于选模空态，或目标自定义类型的绑定模型已不可用时发送 `@Agent`：不创建 child TAB，主模型收不到该任务，用户看到原因与「先选 / 先添加可用模型」。不会静默改用 providers 数组第一项，也不会生成 Enso 专属默认。
- [ ] **AC20（R2, R4）** 自定义条目与订阅条目都能被设为全局默认；设为订阅账号下某模型后，J4 / AC7 对该组合成立。
- [ ] **AC21（R7, J11）** 父会话已有 5 个存活 coworker 实例时再 `@` 任何一个 Agent：派发被拒绝，说明需先结束或解雇一个；不出现第 6 个 TAB，已有 5 个实例不被替换或热切。
- [ ] **AC22（R7, R11, J6, J11）** 父会话存在、有可用模型、尚未 `started` 时发送 `@Scout` / `@Enso`：先只 spawn parent 容器，再开新 coworker child TAB；主 coding Agent 不收到原任务、不开主 coding 回合。父会话不存在或已结束时发送：不创建实例、不改去另一个会话、不另开全局 Enso session；用户看到原因和「先打开 / 先恢复会话」的下一步。
- [ ] **AC23（R7）** Enso 在 Agent Types 中以锁定 Built-in / System badge 只读展示；没有删除、禁用、编辑模型、编辑提示或另存同名覆盖的控件。创建名为 `enso` / `Enso` 的自定义类型不能取代它。
- [ ] **AC24（R7, R8）** 关闭全部内置 Agent types 与内置工具后，用户仍能 `@Enso` 并在新 child TAB 得到回复；`@` 候选不再出现被禁用的 scout / worker / reviewer。
- [ ] **AC25（R2）** 首次 Onboarding 的 Provider 主按钮打开与模型中心相同的统一向导，导入次按钮继续打开独立本机导入；不出现仅能打开旧订阅列表的 onboarding 专用分支。
- [ ] **AC26（R4）** 持久化默认只含 provider entry id + model id；新建对话仍沿用现有 reasoning / thinking 缺省，修改全局默认不会一起改思考档。
- [ ] **AC27（R7, J10）** 主聊天已打开时点右上角全局召唤或聊天内 Enso 入口：当前 composer 插入 Enso recipient chip 并获得焦点，不换会话，不发送，不出现新 TAB，不出现 Enso 独立窗口 / 抽屉 / 全局 session / snapshot。设置窗或 Onboarding 在已有普通会话时点同一入口：切回主窗、聚焦该会话并预填 `@Enso`，同样不打开独立 Enso 界面、不自动派发。
- [ ] **AC28（R5, R7, J10）** 设置 / Onboarding / 主窗没有会话时点召唤：新建一条普通会话（有全局默认则带上该默认，没有则选模空态）并预填 `@Enso`。选出可用模型之前发 `@` 走 AC19；有可用模型但父未 `started` 时发 `@` 走 AC22。不会生成全局 Enso session 或 Enso 专属默认。
- [ ] **AC29（R8, R10, J7）** 用户 `@Enso` 要求把主题改成 Dark（或等价可逆项）：不弹 ASK；设置页 Appearance 立刻变为 Dark；**Enso child TAB** 出现回复，并写完整已脱敏 receipt「主题：旧值 → Dark」。主时间线 `completed` custom entry 带安全 receipt summary，不含 raw params / child transcript，不入 LLM context。没有把 Enso 回复内联进主 timeline，也没有抽屉或全局 Enso 历史 / snapshot。
- [ ] **AC30（R8, R9, J7）** 用户 `@Enso` 要求退出某订阅账号：执行前 Enso TAB 每次出现 ASK，摘要含账号标识与「将删除本地凭证」；不存在「本会话总是允许」。拒绝后账号仍可对话；同意后与 AC6 的退登口径一致。Enso TAB 有完整已脱敏 receipt；主通知只有安全 summary。Enso 不自己弹出第二套授权窗。
- [ ] **AC31（R2, R8, R9）** 用户从统一添加向导开始登录某厂商：向导当前步骤切到授权状态页，清楚显示动作、进度、用户码 / 授权链接 / 补充 prompt、失败原因与重试；不得把这些状态堆在厂商列表下方。从 `@Enso` 开始登录：Enso TAB 先 ASK，同意后走现有系统浏览器授权，TAB 呈现「已打开系统浏览器 / 需要用户码」等状态，仍不另开第二套授权窗。未同意则浏览器不会被打开。
- [ ] **AC32（R8）** 向 `Enso` 索要某条目的 API Key 全文：Enso 拒绝或只给掩码。完整 receipt、安全 summary、主通知与之后打开的同一实例记录里都没有 raw params 或密钥明文；要求写入新 Key 时每次 ASK。
- [ ] **AC33（R8, R11）** 用户让 `Enso` 新建一个 readonly 的自定义 agent type 并绑定某可用模型：免 ASK；设置页 Agent types 出现该类型；Enso TAB 写完整已脱敏 receipt。主 `completed` 通知带安全 summary。删除该类型时必须逐次 ASK。用户不能用同名自定义覆盖 Enso 自己。之后可以 `@` 这个新类型，走 AC12。
- [ ] **AC34（R8）** 用户让 Enso 关掉内置工具 Coworker：免 ASK；Built-in tools 开关变为关，Enso TAB 写完整已脱敏 receipt；主通知带安全 summary。之后新启动的编码会话看不到 coworker 工具。打开开关同理。此开关与内置 Agent types 开关都不隐藏、不停用 Enso。
- [ ] **AC35（R9）** `Enso` 连续提出两个危险操作时，两个操作分别 ASK；第二个在第一个未决前不能执行；Enso TAB 显示队首 + 1/N 或等价。来源编码会话即使处于 Full access，也不能跳过 ASK，且没有 allowSession。
- [ ] **AC36（R10）** 危险操作失败（例如退登失败）时，Enso 在自己的 TAB 说明失败原因并写完整已脱敏 receipt；主时间线 `failed` 通知带安全 summary，不把失败说成成功，也不带 raw params。列表条目按现有规则保留或给出重试。
- [ ] **AC37（R7）** 当前版本用户可见位置统一显示 `Enso`，提及显示 `@Enso`，没有「设置助手 / Settings Assistant」占位名；内部身份 `enso` 驱动收件、权限与路由。
- [ ] **AC38（R7）** 一条消息同时选择文件与某个 Agent 时，文件作为该 Agent 的上下文，该 Agent 是唯一收件人；再选另一个 Agent 会替换 chip，不会双投。
- [ ] **AC39（R7, R8, R11, J9）** 用户问「`@Enso 这个软件有哪些能力`」：Enso TAB 的结果覆盖全部用户可见产品领域而不是只列设置；每项至少显示名称 / 用途、参数、风险、当前可用性和不可用原因。结果中没有 IPC channel、任意 shell 命令、完整密钥。主时间线只有不入 LLM context 的通知。
- [ ] **AC40（R7, R8, R11, J8）** 在已启动编码会话发送「`@Enso 给这个任务组一个 scout 和 reviewer`」：主编码 Agent 不参与这一条；Enso TAB 先展示目标就是本父会话的团队方案；用户逐次确认后，**当前父会话 tab 条**真实出现对应成员的唯一 coworker child TAB，逐成员显示成功 / 失败与完整已脱敏 receipt。主通知只带安全 summary。拒绝任一成员只阻止对应危险操作。
- [ ] **AC41（R9, R10）** 同一条危险确认被重复响应：只有第一份有效决策生效，危险动作最多执行一次。存在 pending ASK 时退出应用、结束父会话、解雇该实例或关闭该对话：请求 fail-closed 自动拒绝，危险动作未执行，该 TAB 记录已拒绝 / 已取消。设置窗不维护第二份「Enso 待确认」。
- [ ] **AC42（R10）** 重启后打开同一父会话，仍能切到未销毁的 coworker child TAB 并看到此前回复与完整已脱敏 receipt；主通知上的安全 summary 仍在。本期没有全局 Enso session / snapshot / 独立历史或 audit 文件。
- [ ] **AC43（R7, R10）** 子 Agent 在自己 TAB 主动调用 `message_main` 发送一条显式消息后：主 coding LLM context 含这条消息，不含该 TAB 其余对话，也不含派发 / 完成 custom entry 及其 receipt summary。未调用时主模型不会因为 TAB 里有回复 / ASK / receipt，或主时间线有安全 summary，而读到它们。


---

## Out of Scope

- 改编码会话的默认审批档（保持今天的 `full` 缺省；只约束 Enso 不得继承它）
- 把设置窗合并进主聊天窗，或做云同步 / 账号体系；设置 / Onboarding 只通过召唤切回主窗
- 累积式命令白名单、把 `allowSession` 持久化到磁盘
- 不新增独立 audit 日志文件或导出操作历史；本期记录是各 coworker child TAB 的完整已脱敏 receipt + 主通知上的安全 summary
- 全局 Enso 窗口、抽屉、独立 Enso session、全局 Enso snapshot、跨窗独立 Enso 工作区，或把全局召唤做成自动派发 / 自动发送
- 把 Enso 回复、ASK、完整 receipt 或 raw params 内联进主聊天时间线（旧 AC 作废）。主通知只允许安全 receipt summary
- 给 Enso 单独的默认模型，或在 Agent Types 里为 Enso 提供模型 / 提示编辑
- 允许删除、禁用、同名覆盖 Enso，或让内置 Agent types / 内置工具开关关掉它
- 把原 `@` 任务交给主模型、让主模型挑选 / 改写收件人、复用旧实例接收新的 `@` 任务，或「已雇佣同类型则切换到该实例」
- 主编码 Agent 自动读取 child transcript，把派发 / 完成 custom entry 或 receipt summary 写入主 LLM context，或把 child 回合默认写入主模型后续 context。本期唯一进入主 LLM context 的自动通道是 child 主动调用 `message_main`
- 父会话改选模型时热切已运行子 Agent
- 旧口径「首期只有 file + Enso」；本期候选是锁定 Enso + 未禁用内置 + 合法自定义
- 旧口径「主 custom entry 不含 receipt」；本期主 `completed` / `failed` 通知投影安全 receipt summary
- 工作区里另一任务的 `.omp/extensions/enso-subagent-guard/**` 与 `src/tooling/trellisSubagentGuard.test.ts`
- Onboarding 的 skill / MCP / 指令 / 预设 / agent type 步骤；Provider 主按钮复用统一向导、导入次按钮独立属于本期范围
- 向 Enso 暴露 raw IPC、任意文件 / 命令 / MCP、明文密钥；全部执行必须走领域 capability
- 重做选模级联菜单、状态栏段位、provider 分组算法（只要求默认模型选择器口径与它们一致）
- 扫描更多本地应用、新 OAuth 厂商、多账号模型本身（已有）
- 把容量上限做成用户可配置项；本期固定为每个父会话 5 个存活实例

顺手能做、明确不做：聊天区 ModelPicker 视觉改版、把额度画到模型中心每一行、给编码会话加「跟随全局默认」开关。

## Key Decisions

| 决策 | 结论 | 来源 |
| --- | --- | --- |
| 全局默认模型失效时怎么回退 | 自动切到仍可用的第一条目的第一个已启用模型并写回全局默认；设置页提示旧值 → 新值；无可用模型时清空并阻止发送；不改已有会话，不热切已运行子 Agent | 用户 2026-08-28 拍板 |
| 全局默认保存范围 | 只保存 provider entry id + model id，不绑定 reasoning / thinking | Lead 按最小范围收敛 |
| 模型提供商入口与授权形态 | 顶栏只留独立导入 + 一个统一添加；先选提供商再展示订阅 / API Key；Onboarding 复用；授权是向导当前步骤 / 状态页 | Lead 依据用户原话收敛 |
| `@Agent` 路由 | typed `{ kind: 'agent', id }` 确定性派发；用户选谁就雇佣谁。每次 mention 新建唯一 coworker child TAB，不复用、不「已雇佣则切换」。主模型不收原任务、不读 child transcript | 用户 2026-08-28 本轮拍板 + 架构硬合同 |
| 未 started 的父会话 | 先只 spawn parent 容器，再开 child TAB；不开主 coding 回合，不把原 `@` 任务交给主模型。父会话不存在或已结束才拒绝 | 架构 2026-08-28 硬合同 |
| 子 Agent 模型 | 配置了绑定模型则用绑定；未绑定（含 Enso）在雇佣当下继承父会话当前模型。父会话之后改选只影响新雇佣的未绑定实例，不热切已运行实例。没有 Enso 默认 | 用户 2026-08-28 本轮拍板 |
| Enso 的品牌身份与锁定 | 展示名 `Enso`、提及 `@Enso`、内部稳定 id `enso`；不可删除、不可禁用、不可同名覆盖；不受 disabled 开关影响。Agent Types 只读展示 Built-in / System badge | 用户 2026-08-28 硬需求 |
| 可提及范围 | 候选 = 锁定 Enso + 未禁用内置 + 合法自定义 + 文件上下文。`general` 不进候选。旧「file + Enso only」作废 | 用户 + 架构 2026-08-28 硬合同 |
| 全局召唤 | 只预填 / 导航；设置 / Onboarding / 无 chat 时聚焦已有普通会话或新建一条。点击不雇佣、不打开独立窗 / 抽屉 / 全局 Enso session / snapshot | 用户 2026-08-28 本轮拍板 |
| 派发失败 | 无可用模型、容量已满（每父会话 5 个存活实例）、父会话不存在 / 已结束：拒绝雇佣。尚未 started 走 parent 容器，不是失败 | 用户 + 架构 2026-08-28 |
| Enso 权限确认策略 | 只读与可逆写入免 ASK，可逆写入在 Enso TAB 写完整已脱敏 receipt；危险操作每次在 Enso TAB ASK，禁止 allowSession / 总是允许 / 继承父会话 `full` | 用户 2026-08-28 拍板 |
| 反馈面 | coworker child TAB 是唯一任务面。作废：全局 Enso 窗口 / 抽屉 / session / snapshot / 独立总历史 / Enso 默认 / 「Enso 回复内联主 timeline」 | 用户 + 架构 2026-08-28 |
| Main receipts | 保留 Main receipts。child TAB 写完整已脱敏 receipt；parent custom `completed` / `failed` 通知投影安全 receipt summary。不带 raw params / child transcript | 用户任务书 + 架构 2026-08-28 校正 |
| 操作记录 | 不新增独立 audit 文件；child TAB 完整已脱敏 receipt + 主通知安全 summary 作为本期记录 | Lead 按最小范围收敛 |
| 未决 ASK | 权威确认只活在该 child TAB；其它窗口只把用户送回来，不复制 ASK；首次有效响应生效、重复忽略；应用退出、父会话结束、实例被解雇或关闭该对话时 fail-closed 自动拒绝 | 用户 2026-08-28 拍板，按 TAB 形态改写 |
| 全部能力与团队执行 | catalog 覆盖全部用户可见产品能力 / 设置并报告参数、风险、可用性 / 原因；安全领域能力可执行，危险逐次 ASK；快速组队真实执行且只 target 当前父会话；禁 raw IPC / 任意文件命令 / 明文密钥 | 用户原始硬需求 + 2026-08-28 方向纠正 |
| 主模型可见内容 | 主 coding Agent 不收原任务、不读 child transcript。主时间线的派发 / 完成 / 失败是**不入 LLM context** 的结构化 custom entry；其中 `completed` / `failed` **含安全 receipt summary**。进入主 LLM context 的唯一自动通道是 child 主动 `message_main`。无 context Open Question | 用户 + 架构 2026-08-28 硬合同 |
