# Enso typed mention / invocation UX 合同

## 身份与范围

- 展示名 `Enso`；提及 `@Enso`；稳定 Agent id `enso`。
- 首期候选实体仅 `file` 与 `agent:enso`；不列 Scout / Worker / 自定义 Agent / coworker。
- Enso 是通用品牌 Agent，但权限只来自 capability catalog；名称不扩权。

## 发现性与路由

- 有 Composer：提示「输入 @ 选择文件或 Agent」；空 `@` 显示 `Agents` / `Files`，Enso 固定第一并有能力说明。
- 无 Composer：持续可见 `Ask Enso`，打开统一轻量输入并预选 `@Enso`。coachmark 不能代替入口。
- Enso 是结构化 recipient `{ kind:'agent', id:'enso' }`。消息只进 Enso 独立会话；当前编码 Agent 不收消息、结果或工具。
- 来源显示执行卡与摘要；点击展开同一 Enso 历史。卡片/摘要不写编码 Agent jsonl。
- file mention 是显式、cwd 内、有界、只读、不可变上下文；Enso 仍是唯一 recipient。

## 模型与空态

- Enso 每次 invocation 以 auth.json 真 keys 校验当前模型；仍有效就继续。仅 create、当前模型失效的恢复、worker/session 重建按全局默认解析；不继承来源、无专属设置、默认变化不热切。
- 无可用默认或真凭证暂不可读不得 spawn；执行卡给选择/添加或重试动作。

## ASK 与跨窗口

- read / reversible 免 ASK但逐笔回显；dangerous 每次 ASK，无 allowSession。
- pending ASK 绑定 Enso 会话中 Main 单一队列；requestId 首次响应 settle，重复幂等。
- 来源窗关闭后其它窗只显示非打断提示；点击进入同一 Enso 历史处理，不复制。
- 所有窗口关闭、Enso 终止、应用退出时 fail-closed。

## 团队 target context

- 从编码会话 `@Enso` 时，origin conversationId 是 Router 绑定的 target；模型参数不能自填或切换 target。
- Enso 可列 agent types 与 origin 会话 coworkers。
- `team.hireCoworker` / `team.dismissCoworker` 是 dangerous，每次 ASK；Gateway 只调 origin 会话的受控现有函数。
- 无 origin、会话未启动/已结束时返回 actionable unavailable，不能静默换目标。

## OAuth 双宿主

- 共用一个 `useOauthLoginFlow` / `OauthLoginStep`。
- 手动添加宿主：ProviderSetupWizard 当前步骤。
- Enso 发起宿主：同一 invocation 卡/Enso 历史中的引导步骤。
- 不假设设置向导已打开，不复制授权状态机。

## 全量能力可感知

- `enso_capabilities` 可 list/describe 全部用户可见产品能力与设置；每项含 description/schema/risk/target-context/availability。
- Catalog 每项必须是 executable 或 known-unavailable；后者说明原因与下一步。
- Catalog 不等于 raw IPC：内部 lifecycle/debug/transport 不纳入；任意 bash/filesystem/MCP/明文密钥仍禁。
- 门禁保证 inventory→catalog→handler 完整并覆盖权威常量；非集中式新 UI action 由 spec/checklist + reviewer 更新 inventory，不扫描任意按钮。

## 四通道传输

- `BUILTIN_AGENTS_INVOKE` 发调用；`BUILTIN_AGENTS_INVOCATION_EVENT` 发执行卡 machine event（含 credentials-unavailable）。
- `BUILTIN_AGENTS_EVENT` 是 Enso 实时 worker event；`BUILTIN_AGENTS_SNAPSHOT` 把 jsonl 恢复为 SessionSnapshot。
- EnsoHistoryDrawer 用 SNAPSHOT 初始化、EVENT 归并；不存在 HISTORY(events[]) handler 或第二份历史。
