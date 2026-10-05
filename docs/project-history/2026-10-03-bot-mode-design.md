# Bot 模式设计

状态：已实现（分支 `enso/aa501d56`，实验开关默认关闭），实现记录见文末「实现与验证记录」。基于 `main@6382922c7` 重新设计，不继承 `EnsoBot` 分支的代码、数据和独立安装包方案。界面设计稿见 [`2026-10-03-bot-mode-mockup.html`](2026-10-03-bot-mode-mockup.html)。

## 目标

同一个 EnsoCode 应用里并存两种模式：

- **Code 模式**：保持现状（项目 → 会话 → worktree / diff / plan / subagent）。
- **Bot 模式**：一组有人设的 AI 成员。可以私聊、拉群，成员之间可以委派工作，每个成员有长期记忆，可以定时执行例行任务。成员真正干活时，复用 Code 模式同一套 worker、工具、审批和会话持久化。

不分期，以下全部属于本次交付。

## 参考结论

| 来源 | 采纳 | 不采纳 |
|---|---|---|
| akeru-bot（T3 Code fork） | 群聊每轮单一回复人（@ 优先，其次群主）；委派=子会话+结果只投递一次；权限取父子交集；重启时未完成委派判失败、不重放；按 bot/群划分记忆 | 隐藏项目概念；事件溯源整套重写；远程沙箱、外部渠道、语音 |
| OpenGrokBot | 成员 scope 一句话驱动路由；轮次上限防循环 | 每条消息由分派器选 1–3 人同时回复 |
| 旧 EnsoBot 分支 | 教训：自建气泡 / snapshot / 留言板 / 任务队列，与 jsonl 形成两套权威源，串聊和 seq 回退都出在这里 | 全部 |

## 关键事实（main 现状）

- 会话权威是 Main `SourceAuthorityRegistry` 的 `ConversationAuthority{conversationId, projectId, kind:'root', lifecycle}`（`src/shared/types/agent.ts:748`），会话必须挂在 active 项目下，cwd 只能是项目路径或已登记的 worktree（`src/main/ipc/agent.ts:245`）。正文的权威源是 pi jsonl。
- 所有会话共用一个 utility worker。事件按 `seq/generation` 单调递增，经 `broadcastAgentEvent` 广播到所有窗口。
- 人设可以复用 `systemPrompt → replacePersonaParagraph`（`src/agent/supervisor.ts:493`）：只替换 pi 开头的角色段，工具说明和规则保留。
- 子代理只有一层（child 不带 subagent 工具），`AgentService` 的 owner 只有 `chatSession`，child 一律折算到根会话。
- capability 授权只开放给 `agent:enso` locked child。
- 记忆空间只有 `global` 和 `proj:<id>`（`src/main/services/memory/types.ts`）。
- 没有定时器、调度器。
- 新增 UI 模式可以照远程节点的做法：`App.tsx:315` 整块切换，另写 Sidebar / Chat；`MessageTimeline`、`Composer`、`ChatHostContext`、`ApprovalBar`、`AskBar` 都靠 props 驱动，可以直接复用。

## 总体架构

```text
Renderer  ModeSwitch ─┬─ Code（现状不变）
                      └─ Bot: BotSidebar / BotChatView / BotProfilePanel / BotInbox
                              │ 只传 botId / chatId / messageId
preload   window.electronAPI.bots.*  (typed)
Main      services/bots/
            botStore          成员档案（文件）
            chatStore         私聊/群聊元数据 + 群聊记录（jsonl）
            botSessionHost    (chatId, botId) → 根会话；spawn/恢复/投递/收尾
            groupRouter       纯函数：谁回复、轮次上限
            groupTranscript   纯函数：给某成员的增量上下文
            delegationService 委派记录、并发/深度、结果投递
            routineScheduler  定时例行任务
          复用：SourceAuthorityRegistry / agentHost / AgentSessionIndex / memoryHost
Worker    复用 pi 会话；新增 bot 扩展：人设段 + 群上下文 + delegate/check_delegation 工具
```

核心原则只有一条：**一个成员在一个聊天里 = 一个普通根会话（pi jsonl 是权威）**。Bot 模式不另建消息存储，只有群聊的「谁说了什么」时间线由 Main 单独保存。这条时间线只写入最终消息，不写过程，不和会话正文重复。

## 数据模型

### Bot（成员）

存放在 `userData/bots/<botId>/`：`bot.json` 存结构化字段，`persona.md` 存人设正文，`avatar.png` 存原图。大段文本不进 `settings.json`。

```ts
interface BotProfile {
  id: string;
  name: string;              // 群内 @ 用，唯一（大小写不敏感）
  title: string;             // 头衔，如「后端」
  scope: string;             // 一句话职责，用于路由提示和委派目录
  avatar: { color: string; image?: number };  // image = avatar.png 写入时的 version
  engine?: { providerId: string; modelId: string; thinkingLevel?: ThinkingLevel };  // 缺省跟随全局默认模型
  approvalMode: ApprovalMode;            // 复用现有档位，新建默认完全放行（full）
  tools: 'all' | 'readonly';            // 与自定义 agent 类型一致
  skillIds: string[]; mcpServerIds: string[];
  delegation: { canDelegateTo: 'any' | string[]; acceptFrom: 'any' | string[] };
  memory: { enabled: boolean };
  archivedAt?: number;
  createdAt: number; updatedAt: number;
  version: number;
}
```

实现：`src/shared/types/bot.ts`（类型与收窄）、`src/main/services/bots/botStore.ts`。私聊的工作区由聊天的 `workspace` 决定，成员档案不再单独记 home。

- 名字不能与内置 agent 类型重名（大小写不敏感）。
- **归档**（默认的「删除」）：从列表隐藏，私聊、记忆、例行任务全部保留，可恢复；例行任务暂停。**彻底删除**需二次确认，级联删除其私聊、委派会话、`bot:<id>` 记忆、例行任务和成员 home；所在群的历史发言保留（显示为「已删除成员」），群里不能再 @ 他；他若是群主，删除前要求先换群主。
- 支持人物卡 PNG 导入导出（tEXt `chara` 字段，兼容 SillyTavern V2 的 name/description/personality/scenario）。导入时生成新 id，不覆盖已有成员。
- **bot 自己的工作区**：每个成员在 `userData/bots/<botId>/workspace` 下有一个隐藏项目，`ProjectAuthority.kind = 'bot-home'`，Code 侧栏不显示。这样会话、记忆这些以 projectId 为键的链路都不用改，只需要在列项目的地方过滤掉 `bot-home`。

### Chat（聊天）

存放在 `userData/bot-chats/<chatId>/chat.json`。

```ts
interface BotChat {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  members: string[];          // direct 恰好 1 个
  bossBotId: string | null;   // group 必填
  workspace:
    | { kind: 'member-home' }                     // 仅私聊：成员自己的 home
    | { kind: 'chat-home'; projectId: string }    // 仅群聊：独立目录（隐藏 bot-home 项目）
    | { kind: 'project'; projectId: string };     // 基于 Code 项目
  routing: { maxHops: number; maxTurnsPerBot: number };  // 默认 4 / 2，均按每条人类消息计
  pinned: boolean; archivedAt?: string;
  sessions: Record<string /*botId*/, { conversationId: string; cursor: number }>;
  version: number;
}
```

- 私聊可以点「新对话」：在同一私聊里开一个新根会话，旧会话进资料面板「历史」页签，只读。群聊不提供。
- 成员 home 和群的独立工作区都放在 userData 下，UI 提供「在访达中打开」。
- 私聊：`workspace` 默认为成员自己的 home，也可以改绑某个 Code 项目。改绑之后另开一个新会话，旧会话只读保留（与 Code 模式切项目的语义一致）。
- 群聊：所有成员共用同一个工作区，**新建群聊时二选一**：
  - **基于 Code 项目**：从 Code 侧栏现有的本地项目中选一个（不列出 ssh 项目），成员直接在该项目目录里读写。项目的 AGENTS.md、技能和项目信任确认与 Code 会话完全一致，和成员人设同时生效。群不会出现在 Code 侧栏，Code 项目也不会因此改变。
  - **独立工作区**（与 akeru / OpenGrokBot 相同）：在 `userData/bot-chats/<chatId>/workspace` 建一个空目录，登记为隐藏的 `bot-home` 项目。
  - 两种都会提示「群内成员共享这个目录」。之后可以在群信息里改选，改选后所有成员各开一个新会话，旧会话只读保留，时间线不变，cursor 重置到当前末尾。
  - 绑定的 Code 项目被移除时，群变为只读，并提示重新选择工作区；独立工作区随群删除一并清理。
- 每个成员在每个聊天里有自己的根会话，记在 `sessions[botId]` 里。`ConversationAuthority` 新增可选字段 `bot?: { botId; chatId }`，由 Main 写入，renderer 不能指定。

### 群聊时间线

存放在 `userData/bot-chats/<chatId>/timeline.jsonl`，只追加，每行一条：

```ts
type GroupEntry =
  | { seq; id; at; kind: 'human'; text; attachments?; mentions: string[] }
  | { seq; id; at; kind: 'bot'; botId; text; conversationId; turnId }      // 成员一轮的最终回复
  | { seq; id; at; kind: 'delegation'; delegationId; from; to; state; summary? }
  | { seq; id; at; kind: 'system'; text };                                  // 加人/改名/路由上限
```

- `seq` 在单个聊天内单调递增，由 Main 分配。推送和分页都按 seq 走。
- 成员回复取自 worker 的 `turn-completed` 里最后一条 assistant 文本（权威），不需要额外的 say 工具。工具过程留在该成员的会话里，UI 可以展开查看。
- 私聊不写时间线，直接显示那一个会话的正文。

### Delegation（委派）

存放在 `userData/bot-chats/delegations.jsonl`，内存里有投影。

```ts
interface Delegation {
  id; parentConversationId; parentBotId; targetBotId; chatId: string | null;
  task: string; context: string;            // context ≤ 8k 字符
  childConversationId: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  failure?: 'interrupted' | 'timeout' | 'denied' | 'error' | 'check';   // check = 验收未通过
  result?: string; deliveredAt?: string;    // 只投递一次
  depth: number; createdAt; finishedAt?;
  batchId?: string;                         // 发起时父会话所在轮次的键（host turnKey），同父会话同 batchId 为一批
  taskId?: string;                          // 关联的群任务看板任务（见「群任务看板」）
  retryOf?: string;                         // 由哪条委派重试而来；被指向的记录即「已重试」
  timeoutMinutes?: number;                  // 本次时限（发起方 deadlineMinutes 与目标上限取小）
  keep?: true;                              // 父回合被停止 / 中断后仍继续
  check?: { kind: 'output-contains'; text: string; passed?: boolean };  // 可验证完成条件，见「可验证完成条件」
}
```

### Routine（例行任务）

存放在 `userData/bots/<botId>/routines.json`：`{id, title, prompt, schedule: cron, chatId, enabled, lastRunAt, lastResult}`。触发后作为一条系统发起的消息投进指定聊天。（2026-10 起 `enabled` 改为状态与审批版本，另有运行历史，见文末「例行任务生命周期」。）

## 关键流程

### 私聊发送

1. Renderer 调用 `bots.send({chatId, text, attachments})`。
2. Main 校验 chat 存在且成员未归档，再按 `chat.sessions[botId]` 解析出会话：没有就新建（authority + spawn），休眠中就带 resumeFile 恢复，正在运行就走现有的 steer 插话。
3. 之后的事件走现有的 `AGENT_EVENT`，由 sessions store 的 reducer 归并。BotChatView 直接用该会话的投影渲染。

先确认能发给 worker 再做 optimistic echo；被拒绝时不回显（AGENTS.md 约束）。

### 输入框：@文件 / @聊天 / $技能 / 语音 / 草稿

`BotComposer` 仍是轻量 textarea，补齐 Code 输入框的几项能力，全部只传标识符：

- **@文件**：复用 `useMentionSearch`（新增 `searchFiles` 选项替代按 cwd 搜索）；补全走 `BOT_FILE_SEARCH {chatId, query}`，根目录由 Main 按聊天工作区推导（`host.workspacePath`），入参多一个键即拒绝。选中后正文内联 `@相对路径`（与 Code 同格式，模型用自己的读文件工具读），同时把路径放进 `send.files`；Main 发送前逐个 `realpath` 校验仍在工作区内且存在（`..`、绝对路径、指向外部的软链都拒绝，`file-outside-workspace`）。
- **@聊天**：候选是其他未归档的 Bot 聊天，选中成为 chip，`send.chats` 只带 chatId（每条最多 3 个）。Main 校验存在且不是本聊天（`chat-ref-not-found` / `chat-ref-self`），投递时生成 `<chat-reference id title kind>` 摘录：私聊取成员当前会话当前分支（每轮人类输入 + 该轮最后一条有正文的回复，剥掉笔记块、嵌套引用、技能块折成 `[skill: 名称]`），群聊取时间线 human / bot 条目；都取最近 3 轮（从倒数第 3 条人类消息起），单条裁到 1200 字，整段超 4000 字从最早的丢并注明省略条数；正文里的 `<chat-reference` 被中和，不能提前闭合。气泡里摘录块折叠成 chip。
- **$技能**：候选是成员 `skillIds` 对应的设置技能（群聊为各成员并集，并标出谁有）；一条消息一个技能，`send.skill` 只带技能 id。Main 按 Code 侧约定（pi `/skill:` 展开格式：`<skill name location>References are relative to …</skill>` + 正文）自己读 `SKILL.md` 拼块：私聊必须是该成员的技能，否则 `skill-unavailable`；群聊只要有成员可用即可，人类条目只存 `refs: {chats, skill}`，`groupChat.deliver` 按**被投递成员**各自的技能集合展开——有就给技能块，没有就给一行 `<skill-unavailable>`；输入框里 @ 到的成员没有该技能时先提示。
- **语音**：复用 Code 的 `VoiceInputButton`（同一开关、模型就绪判定与按住说话快捷键），识别结果插到光标处。
- **草稿**：按聊天存 `localStorage['enso-bot-draft:<chatId>']`（正文、文件、聊天引用、技能；图片不存），坏数据回落为空、配额满不抛；输入框按 chatId 设 key 重新挂载，草稿不跨聊天。`seedBotDraft` 供引导流程和回退回填写入。

所有引用校验都在 `host.deliver` / `groups.send` 之前完成，被拒绝的消息不会到 worker（Bot 输入框没有 optimistic echo，失败时输入回滚）。

**测试**：`shared/bots/composerRefs`（最近 3 轮、单条 / 整段裁剪、标签中和、拼拆互逆、技能块格式）、`services/bots/composerRefs`（越界路径与软链、不存在 / 自引用聊天、成员没有的技能、私聊展开、群时间线摘录、群里按成员解析）、`parseSendInput`（只收标识符、上限、脏输入）、`groupChat`（人类条目只存引用、投递附展开）、bots IPC（越权在 spawn / prompt 之前拒绝、文件补全不接受根目录参数）、`botDraft`（按聊天持久化、坏数据、配额）。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max-0902）：两位成员私聊里 `@launch` 补全出 `docs/launch-plan.md`，各自读出自己工作区的代号；Qwen 私聊 @ Clau 的聊天、Clau 私聊 @ Qwen 的聊天，都准确总结了对方聊天并指出两边代号不同；`$grill-me` 在私聊气泡显示技能 chip、模型按技能只问一个问题；群聊 `@Clau @Qwen` + 引用 + `$grill-me`（Qwen 未配该技能，输入框先提示），jsonl 里 Clau 收到技能块、Qwen 收到 `<skill-unavailable>`，两人都收到同一份摘录；草稿刷新页面后仍在。

### 群聊发送与路由

`groupRouter` 是纯函数，输入是人类消息和当前状态，输出是回复队列：

1. 消息里有 `@成员` 时，按出现顺序逐个回复，`@所有人` 展开成全体成员，按成员顺序排；
2. 没有 @ 时按群的 `routing.mode`：`boss` 由群主回复；`smart`（智能选人，见下）由便宜模型或分类器选 1–3 位成员依次回复；
3. 成员在回复里 @ 了别的成员，就把被 @ 的人追加到队列末尾（去重，跳过自己，也跳过**这一轮刚委派出去的成员**——他的结果会经委派回传，再接力会让他在群里把同一件事重做一遍；正文里其它没被委派的 @ 照常接力，不计跳）。「这一轮」由宿主为每个自己发起的轮次分配的 `turnKey` 判定：委派记录发起时写入 `batchId = turnKey`，轮次结束事件带同一 `turnKey`，群路由用（父会话 id, turnKey）查委派目标；同一条人类消息之后最多 `maxHops` 跳，且每个成员最多回复 `maxTurnsPerBot` 次，超出时写一条 system 提示；
4. 同一时刻每个群只有一个成员在回复（FIFO），保证时间线顺序就是对话顺序；全局同时最多 4 个 bot 会话在跑（私聊、群聊、委派、例行任务合计，Code 会话不计），其余排队并显示「排队中」；
5. 系统写入的条目（委派结果、system 提示）不参与路由，其中的 @ 不触发接力。

轮到某成员时，`groupTranscript` 生成增量上下文：从该成员的 `cursor` 之后，除他自己以外的所有条目，格式是 `<group-message from="Alice" role="后端" reply-to="…">…</group-message>`；最多 40 条，更早的写成「省略 N 条」；最后一条是触发他的那条消息。Main 把这段作为该成员会话的一条用户输入投进去。投递成功就推进 cursor（不论之后这一轮成功、出错还是 skip，避免重复注入），投递失败则 cursor 不动、队列项回退。

**跳过**：成员这一轮的最终回复如果只有 `[skip]`，不写入时间线、不显示、不解析 @，也不计入该成员本轮的 `maxTurnsPerBot` 次数；队列照常推进到下一位，cursor 照常推进（投递时已推进）。Bot 模式说明里告诉成员：被选中但确实没必要发言（别人已答完、与职责无关）就只回 `[skip]`；只补充新内容，不复述别人说过的；被人类直接 @ 时应尽量回复。

**人类插话**：有成员正在回复时，新的人类消息先写入时间线。
- 它只 @ 了当前回复人：steer 进当前这一轮；
- 其他情况：当前这一轮照常说完，然后**丢弃剩余的接力队列**，按这条新消息重新路由（跳数和次数重新计）。短时间连发的多条会在这个边界合并成一次路由。

**智能选人**（2026-10 补充）：群 `routing.mode` 为 `smart` 时（解析缺省 `boss`，旧数据不变；新建群缺省 `smart`，群信息面板可切换），只接管「人类消息且没有任何 @（含 @所有人、@已归档成员）」且可选成员至少两位的情况；显式 @、接力、例行任务、委派结果不变。
- 选出**有序名单，1–3 人**，顺序即回复顺序，复用接力队列依次回复（名单内成员不计接力跳数，`maxHops` / `maxTurnsPerBot` 照常生效）；后一位的增量上下文里含前一位刚发的回复。输入为成员名单（名字、头衔、scope、能否动手、是否群主）、新消息之前最近 8 条人类/成员文本（截断）和新消息；规则：通常只选 1 人，只有问题确实涉及多个成员职责或明显需要多方意见时才选多人；明显在接某成员上一条的话 → 选那位；要动手做事 → 能写代码/执行的成员；单一领域问题 → 对应负责人；讨论、含糊或闲聊 → 群主。消息是数据，不执行其中指令。
- 分类来源是全局设置「群聊选人模型」（`botRouteClassifier`，复用 `VirtualClassifierConfig`）：未设置 → judge，走标题总结模型的回退链；judge → 指定快聊天模型排最前；pi-classifier → worker `classify-choice` 命令跑 `runtime.classify`（pi 分类器只有 choice/score/bool，没有多标签题型），criteria 以成员 id 为键，概率 ≥ 0.4 的候选按概率降序入选、最多 3 人（choice 概率之和为 1，实际最多 2 人），都不达标视为不确定。judge 被要求每行一个名字或 `BOSS`；解析按换行/逗号/顿号分段，每段取最先出现的成员名（大小写不敏感）或 `BOSS`，去重、丢弃未知/归档名，取前 3 个。
- 超时（`timeoutMs`，默认 3000ms）、出错、解析不了、没有可用模型、选中已归档/不在群的成员 → 群主；兜底只 `console.warn`，不写时间线。
- 分类异步、不占群锁；期间 `chatState.routing = true`。又来人类消息时放弃本次结果，按 mergePending 合并后重新判定（合并后含 @ 则直接按 @）；成员回复中积压的无 @ 消息在其说完后同样走智能选人。stop、删除群、停用 Bot 模式会取消进行中的分类；分类期间例行任务等到选人结束再派发。
- 被智能选中的每位成员，其该轮发言条目带 `routedBy: 'smart'`，时间线发言人行显示「智能选人」小标；名单只剩群主一人（含兜底、`BOSS`）时不标，群主作为多人名单之一时标。人类插话时当前成员说完即丢弃名单剩余成员，按新消息重新选人。

**静音成员与意图**（2026-10 补充）：
- 静音按群设置，存 `routing.muted: botId[]`（解析时只留在群的非群主成员、去重，为空省略；旧数据不变；团队导出不带）。群信息面板成员菜单切换「静音 / 取消静音」，群主不可静音。静音成员只在被**点名** @ 时发言（人类或成员正文里 @ 他都算）；正文含 @所有人 时展开结果去掉未被点名的静音成员；智能选人的候选、选人名单与群主兜底都跳过静音成员；`needsSmartRoute` 的「至少两位」按未静音成员计。
- 意图 `build`（要改代码/文件/执行）/ `answer` / `discuss`：judge 回复首行 `INTENT: …`，其后是名单；pi-classifier 在成员题之外并发再问一道意图 choice 题（criteria 为三种意图），最高概率 ≥ 0.5 才采信。判不出（judge 缺 INTENT 行、分类器意图题不可用或不达标）时用中英文关键词兜底：讨论词优先 → discuss；动作词且不是单纯提问（或带「请/帮我/please/can you」等请求语气）→ build；其余 answer。选人整体失败（超时、出错、没有模型）仍直接交群主，不判意图。
- `build` 只派 1 人：在名单（分类器为全部候选按概率降序）里取第一位能动手（`tools = 'all'`；现有审批档位都不是只读）的成员，名单里没有就按群成员顺序取第一位；群里没有能动手的成员 → 交群主并写系统条目「没有能改代码或执行命令的成员，交给群主处理」。被选成员的这次投递末尾附 `<routing-note>这是执行类请求：先动手完成，再简要汇报。</routing-note>`，只附一次，接力不附。`answer` / `discuss` 维持 1–3 人。
- `routedBy` 扩为 `'smart' | 'smart:build' | 'smart:answer' | 'smart:discuss'`，时间线小标显示「智能选人 · 执行 / 解答 / 讨论」；标注规则不变（只剩群主一人不标）。

**群主汇总提醒**（2026-10 补充）：群主派单后由群主收口，避免成员说完就散。
- 群主的回复里经 @ 接力**实际入队**的成员（跳过自己、归档、静音被丢弃、已在队列、本轮已委派、被上限拦下的）记入 `RouterState.waiting`，已回复的记入 `reports: { botId, seq? }[]`，随 router 状态写入 `router.json`（可选字段，旧数据缺省为空；名单清空即删除两字段）。普通成员互相 @、智能选人选出多人都不记。
- 名单成员这一轮结束即移出：有正文记其时间线条目 seq；`[skip]`、回复失败、投递不可用视为已回报但无 seq。名单清空时，若最后这条回复已 @ 群主或群主已在队列中（会被接力叫醒），或所有人都没有正文，不另发；否则给群主追加一跳：投递末尾附 `<routing-note>你派出的成员都已回复：「A」（seq 12）、「B」（未发言）。请在群里汇总结论或决定下一步，不要复述他们的原话；需要原文可用 group_history 按 seq 查。</routing-note>`，不写 human 条目（成员回复本就在群主增量里）。
- 这一跳计入 `maxHops` 和群主的 `maxTurnsPerBot`；到上限不发，写一条 system 说明（与接力上限共用「每种只提示一次」）。人类插话按现有边界重新路由时名单随新状态清空，停止同理。群主汇总发言带 `routedBy: 'summary'`，时间线显示「群主汇总」小标。群主在汇总里再 @ 成员会开始新一组名单，仍受上限约束。

**成员会话之间互不影响**：每个人的会话只看到自己经历过的上下文，再加上群时间线的增量。压缩和恢复都只发生在单个会话内部。

### 委派

bot 会话额外挂两个工具：

- `delegate({to, task, context?, taskId?, deadlineMinutes?, keep?})`：校验 `canDelegateTo/acceptFrom`；群聊里只能委派给本群成员；不能委派给委派链上游的成员（结果本来就自动回传，真机里被委派方曾反向委派「汇报完成」绕圈）；深度 ≤ 2，单个父会话并发 ≤ 3。通过后为目标成员新建一个**委派会话**（根会话，`bot.chatId = null`，`parentDelegationId` 有值，不出现在聊天列表），立刻返回 `delegationId`。参数归一化（`"30"`→30、`"true"`→true、null 删除）在 schema 校验之前。
- `check_delegation({id?, cancel?})`：查看状态或取消。

**权限**按目标成员自身能力执行：工具集（tools）、技能（skillIds）、MCP（mcpServerIds）都用目标成员自己的配置，审批档取父子两者中更严的一档；能不能委派只由 `canDelegateTo/acceptFrom` 控制。工作区沿用父会话的工作区（被委派的人在委托方的目录里干活）。之所以不取交集：委派的意义就是把自己做不了的事交给有能力的成员，真机里只读的项目经理委派全栈工程师改文件，交集后子会话只剩只读，委派形同虚设；风险由委派授权名单和更严的审批档兜住。这条只管委派会话，readonly 成员自己的 `subagent` 子代理仍保持只读。

**完成判定**：子会话 `turn-completed` 且这一轮没有以错误或中断结束，才算完成；result 取最后一条 assistant 文本。带 `check` 的委派还要过验收（见「可验证完成条件」），未通过记 `failed / failure:'check'`。

**结果投递**：父会话空闲时注入 `<delegation-result id="delegationId">` 唤醒它；父会话忙时等到本轮终态。同一父会话同一轮发起的多个委派（同 `batchId`）是一个批次：先到的结果暂存，批次全部到终态（completed / failed（含 timeout、interrupted）/ canceled）后合并为一条 `<delegation-results id="batchId">` 注入，内含各条 `<delegation-result>`；批次未齐时在群时间线写 system 提示（如「小设 已完成，等待 阿全」，私聊无提示，级联取消不提示），齐了不额外提示。单委派批次格式与 deliveryId 不变；不在宿主轮次内发起的委派与 UI 重试产生的委派各自成批（重试不并入原批次）。批次状态完全由持久化记录按（parent, batchId）聚合推导。稳定 `deliveryId`：单条为 `delegationId`，多条为 `batchId`；父会话实际开始处理后才给批次内每条记录写 `deliveredAt`；重启后未确认结果至少一次重投，父会话依据内存及 jsonl 用户消息中的结果 id 去重。群时间线只保留一条带 `summary` 的 `delegation` 条目，供卡片与增量上下文使用，不再以被委派成员名义重复写 `bot` 消息；该条目不触发路由。

**重启**：在 worker 恢复之前，把所有 queued 和 running 的委派标为 `failed/interrupted`，不自动重放（可能已经写盘），并通知父会话（因此重启后不存在部分完成的批次，已全部终态但未投递的批次按原 batchId 补投一次）。用户可以在 UI 里点「重试」，重试会生成一条新记录。

**重试**：只允许 `failed`（含 timeout / interrupted / error）与 `canceled`；新记录带 `retryOf = 原 id`，已被某条记录 `retryOf` 指向的不能再重试（链式重试只能重试最新那条）；重试走 `delegate`，同样受单父会话并发 ≤ 3 约束，自成一批（standalone），时限沿用原 `timeoutMinutes` 并按目标当前上限再收紧。renderer「已重试」只读 `retryOf`；收件箱的中断提示另外仍隐藏「之后成员自己重新委派了同目标同任务」的记录。

**超时**：`BotProfile.delegationTimeoutMinutes?`（1–1440 整数，缺省 240）是该成员**作为被委派方**的上限；`delegate` 可传 `deadlineMinutes` 要求更短，超过上限按上限执行并在返回里带 warning。实际时限写进记录 `timeoutMinutes`，卡片显示「超过 N 分钟未完成」。计时从创建记录起（含排队）。

**父回合中断级联**：宿主在进行中的回合被用户停止或中断时给 `BotTurnFinished` 打 `stopped`——群聊 `stopTurn`、私聊停止（worker 以 `stopReason=aborted` 结束）、`abortConversation`、会话退役、settle 兜底的 `interrupted`、`worker-exited`；预算 / 单回合上限停止与普通出错**不算**。`DelegationService` 收到 `stopped` 后按（parentConversationId, batchId = 该轮 turnKey）取消这一轮发起、未标 `keep` 的进行中委派（不写批次等待提示），群看板关联任务随 `canceled` 退回待办，`keep` 的继续跑、任务保持进行中。批次一致性：取消后若批次已无进行中的记录，直接把整批标记已投递（群里照常落 `delegation` 条目），**不再注入结果唤醒父会话**——用户停下就是要停；仍有 `keep` 在跑则整批（含被取消的）等它结束后照常合并回传。被取消的子会话自己的回合也以 `canceled` 结束并带 `stopped`，从而逐级取消孙委派。重试产生的委派没有 batchId，不受任何回合级联。

Code 模式现有的 `subagent/workflow` 对 bot 会话照常可用，用于临时开的一次性助手，和委派不是一个概念，互不影响。

### Code 模式里调用 bot

成员会登记成 agent type `bot:<botId>`，在 @ 补全里单独成组并标注「成员」。Code 会话里可以用 `@成员名` 或 `subagent agent_type=bot:<id>` 拉他当 coworker，人设、模型、工具都按成员档案来，工作区是当前 Code 会话的目录。走的是现有的 child 链路，不新建委派记录。

### 记忆

- 新增空间：`bot:<botId>`、`chat:<chatId>`（群）。需要修改 `isSpaceId`、`resolveSpaceIds`、工具 schema 的 `spaceId` 枚举（新增 `bot`、`chat`）和蒸馏归属。
- bot 会话默认检索顺序：`bot` → `chat`（仅群聊）→ `project`（工作区是 Code 项目时）→ `global`。`capture` 默认写入 `bot`。
- 自动蒸馏：bot 会话很少「结束」，因此除会话结束外，在空闲释放（30 分钟）和私聊「新对话」时各蒸馏一次增量（记录已蒸馏到的 entry，避免重复）。归属按 `ConversationAuthority.bot` 推导出 bot/chat 空间。
- 群聊分流：群聊成员会话（authority 有 `bot.chatId` 且该聊天是 group）的蒸馏任务 payload 带 `chatId`，提示词追加 `DISTILL_GROUP_SCOPE_RULES`，模型给每条结论标 `scope`：`chat` = 与整个群相关（团队约定、决定、项目背景、分工、术语）→ `chat:<chatId>`；`self` = 成员个人偏好 / 工作习惯 / 经验 → `bot:<botId>`；缺省或无法识别按 `self`。大线程合并阶段把 scope 带进候选清单并保留。私聊、委派子会话（`chatId=null`）不带 `chatId`，行为不变。水位线 / 指纹 / 去重都不变（去重本来就按 space）。删除群时 `deleteMemorySpace('chat:<id>')` 除了删记忆，还把待续跑任务 payload 里的 `chatId` 去掉，避免重启续跑把结论写回已删的群空间（成员自身部分照常落 bot 空间）。
- 主动 capture：memory 工具的 `spaceId` 描述与群聊成员提示都说明——群约定 / 决定 / 背景 / 分工 / 术语写 `'chat'`，个人偏好与经验写 `'bot'`。
- Bot 资料面板里可以查看、编辑、删除该成员的记忆。

### 核心笔记（自动注入）

成员常常想不起主动查 memory 工具，因此每个成员 / 群维护一份短笔记，会话启动时直接放进提示词。

- 存储：成员笔记 `userData/bots/<botId>/notes.md`，群笔记 `userData/bot-chats/<chatId>/notes.md`（仅群）。上限 `BOT_NOTES_MAX_CHARS = 3000` 字符，写入时截断，空内容删文件。version 为内容 SHA-256 前 16 位，不另存元数据。笔记跟随所属目录，删除成员 / 群时由现有 `rmSync` 一并清理；目录已不存在时写入返回 `not-found`，不会重建。
- 更新：`BotMemoryService.distill` 水位前进（有新内容被整理）后回调 `onDistilled({botId, chatId, since})`，不等待。`BotNotesService.afterDistill` 按成员串行：取 `since` 之后 `source='distill'` 写入 `bot:<id>` / `chat:<id>` 的结论，用 Bot 助理模型链（`assistantCompleter`）把「旧笔记 + 新结论」重写（去重、新的覆盖旧的、删过时内容，只输出笔记）。没有新结论不调模型；模型失败 / 超时 / 空输出保持旧笔记。写回带旧 version，冲突（用户手动改了、或群里别的成员同时更新）就基于最新笔记重来，最多 3 次。成员 `memory.enabled=false` 时既不更新也不注入。
- 注入：`BotSessionHost` spawn 时在人设之后追加 `# Long-term notes` 段，用 `<member-notes>`（群会话再加 `<group-notes>`）包住正文，说明这是长期笔记、细节用 memory 工具查；委派会话只带成员笔记。按 conversationId 记录已注入版本；会话运行中笔记变了（自动重写或手动编辑），下一次 prompt / steer 在消息前追加一次 `<notes-updated>` 块。正文里同名标签会被转义。
- 展示与协议：`stripBotNotesUpdate` 去掉开头的 `<notes-updated>`，渲染层（注入卡片识别、消息气泡、列表摘要）与 `hasStartedDelivery`（委派结果去重）都先剥掉再识别。
- IPC：`BOT_NOTES_GET`（read，`{botId}` 或 `{chatId}` 二选一）与 `BOT_NOTES_SAVE`（write，加 `content`、`version`；version 不一致返回 `conflict`）。群笔记只对群聊开放。变化广播 `BotEvent{kind:'notes', chatId?}`，手机端不转发。
- UI：成员资料「记忆」页顶部「核心笔记」，群信息面板「群笔记」，都可编辑，保存冲突时提示并重新加载。
- 未做：手动 capture（`source='agent'`）不触发重写；重启续跑的整理任务不触发重写；手机端不展示笔记；整理转写里会带上 `<notes-updated>` 块，靠记忆去重兜底。

### 人设与提示词

Main 在 `spawnSession` 里根据 `ConversationAuthority.bot` 组装提示词，renderer 不传正文：

1. `systemPrompt`（角色段）= persona.md + 名字、头衔、职责；
2. `instruction` 追加「Bot 模式」说明：回复要像聊天一样简洁，最终正文就是发出去的消息，怎么委派，群里有哪些成员（名字、头衔、scope 目录）；
3. 模型、工具、技能、MCP、审批档都取自 BotProfile；委派会话用目标成员自己的档案，只有审批档会按委派方收紧到更严的一档。

修改人设只影响新会话或下一次恢复；进行中的轮次不变。

### 审批与提问

- 不新增通道，沿用 `AGENT_APPROVAL_RESPOND` / `AGENT_ASK_RESPOND` 的 exact identity 校验。
- Bot 模式新增**收件箱**：汇总所有 bot 会话和委派会话里待处理的审批和提问，并在对应聊天里内联显示 ApprovalBar / AskBar。后台成员发起审批时给出桌面通知，聊天列表标红点。
- 委派会话的审批归在发起委派的聊天名下显示，并注明「X 替 Y 执行」。
- 新成员默认完全放行，只有用户手动调严时才会出现审批。出现时一直等待（桌面通知 + 手机推送 + 收件箱），不超时；委派受 4 小时总超时约束；例行任务触发的轮次里，审批 30 分钟无人处理自动拒绝。

### 私聊回退与重试

只对私聊当前会话开启（`LiveSessionTimeline` 的 `controls`，ChatHost `canRewind/canRetry`，不开分叉）；群聊与只读历史不开——群时间线是另一份权威记录，单个成员会话回退会与时间线 / cursor 脱节。

- 通道 `BOT_REWIND {chatId, entryId, restoreFiles?}` / `BOT_RETRY {chatId}`：renderer 只给聊天和持久化 user entryId，会话由 Main 按 `chat.sessions` 推导；`AGENT_REWIND / AGENT_RETRY` 对 bot 会话仍然拒绝。
- 复用 Code 的 worker `rewind` / `retry` 命令（含 git checkpoint 文件还原，非 git 工作区静默降级）。宿主 `rewindConversation / retryConversation`：会话忙（运行中或有排队投递）拒绝 `session-busy`；冷会话先带 resumeFile 恢复（只 spawn 不 prompt）。重试像一次投递那样占用回合：新 turnKey、计入并发上限与预算检查、经 `turn-completed` 正常结算并发 `BotTurnFinished`；worker 认为无需续跑（不会进入 running）时宽限期后按 `nothing-to-retry` 结算，回合不悬挂。
- **回退一致性**（worker 接受回退命令后同步收尾，目标 entry 先按 jsonl 当前分支校验，找不到回 `rewind-target-not-found` 且不发命令）：
  - **委派**：该会话在回退点（被裁掉的 user 消息时间）之后发起的委派——进行中的取消（停掉子会话，任务看板经委派终态同步），连同已结束但未投递的结果一起记为已投递作废，不会再注入回退后的会话；已投递的结果随被裁分支离开上下文，不动；回退点之前的委派不受影响。重试不产生新回退，委派照常。
  - **记忆水位**：水位（及 `sessions[botId].distilledTo`）若落在被裁掉的部分，退到回退点前一条 entry（回退到首条则清空），避免 `sliceTranscript` 找不到起点回落全量而重复整理；已经整理进记忆的内容不撤回。
  - **私聊状态**：正文由 worker 的 `messages-truncated` / `rewind-done` 经 bots store 投影归并；`rewind-done` 的回填文本由 `draftFromSentText` 还原成草稿（剥掉笔记块，聊天摘录还原为引用 chip，技能块还原为技能），只回填本窗口发起的回退。

**测试**：`rewind`（委派作废边界、水位前移 / 清空 / 不变）、宿主（冷会话恢复后回退、忙碌拒绝、重试 turnKey 与结算、worker 拒绝立即释放）、bots IPC（目标不在分支、多余参数、群聊 `direct-only`、委派取消与作废、`distilledTo` 退回、忙碌拒绝）、`draftFromSentText`。

**真机**（同上两家模型）：Clau 私聊回退最后一轮，草稿回到输入框；Qwen 私聊回退一条带 @聊天 的消息，输入框还原正文和聊天 chip，重发后摘录反映 Clau 回退后的分支；两人各自写长文时停止（`Request was aborted` + 重试），点重试后被停止释放的会话先恢复再续跑完成，状态回到空闲；Clau 工作区为 git 时让其改文件，「对话 + 还原文件」回退后文件恢复原值。

### 手机端

- pair 协议新增可选帧（旧手机忽略不认识的帧）：
  - 下行 `bot-catalog`（成员摘要：id、名字、头衔、头像缩略图、状态，不含人设正文）、`bot-chats`（聊天列表、未读、最后一条）、`group-timeline`（按 seq 分页，单帧 < 850KB）、`bot-event`（同桌面 `BOT_EVENT`）；
  - 上行 `bot-send {chatId, text, attachments?, deliveryId}`、`bot-chat-open {chatId}`、`bot-timeline {chatId, beforeSeq}`。新命令同时登记到 `PhoneToHost`、`PHONE_COMMAND_TYPES`、`parsePhoneCommand` 和 handleFrame。
- `bot-send` 走和桌面 `BOT_SEND` 同一个 Main 服务，校验一致；主窗口不在时由 headless 的 `pairSessionHost` 承接。
- 私聊：手机订阅该聊天当前成员的会话，复用现有 `agent-event` / `session-sync` / `history` 和消息渲染。群聊：订阅 `chatId`，拿时间线；点「查看过程」时再按需订阅对应成员会话。
- 审批和提问复用现有手机链路（按 exact identity 校验）。后台成员发起审批时和 Code 会话一样发 Web Push。
- 手机端只做：成员和聊天列表、私聊、群聊（含 @ 补全）、审批与提问、委派卡片的取消。新建/编辑成员、新建群、例行任务管理留在桌面。
- 现有 Code 目录（`CatalogEntry`）仍然过滤掉 `bot-home` 项目和 bot 会话，Bot 内容只通过上面的专用帧出现。

### 例行任务

`routineScheduler` 在 Main 里用 cron 解析器计算下次触发时间，用单个 timer 驱动。触发时如果目标聊天正在忙就排队。应用关闭期间错过的触发默认只补跑最近一次（可在例程上关闭），其余标「错过 N 次」，详见文末「例行任务生命周期」。headless 托盘模式下照常运行。

群信息面板的「例行」页签列出所有 `chatId = 本群` 的例行任务（跨成员，renderer 侧用 `BOT_ROUTINES_LIST` 全量结果按 chatId 过滤聚合，不改 IPC），显示成员、标题、cron 描述、启停、上次运行与结果；新建时选本群成员、目标聊天固定为本群，编辑时成员不可改（例行任务按成员存放），删除 / 启停 / 立即运行复用原通道。

### 群任务看板

每个群一份共享任务清单，给多步工作做显式的拆分、认领和交付记录。

- **存储**：`userData/bot-chats/<chatId>/tasks.jsonl`，append-only 整条快照（与 `delegations.jsonl` 一致，后写覆盖），删除写墓碑 `{id, seq, deleted:true}`；坏行 / 截断行跳过；每次追加带前导换行隔离撕裂的末行。`seq` 取历史最大值 +1（含已删除），显示为 `#N`，不复用。删群时整个聊天目录被删，同时清掉内存缓存。
- **字段**：`{id, seq, title, detail?, status: todo|doing|done|canceled, assigneeBotId?, createdBy: 'human'|botId, delegationId?, result?, check?, claimedAt?, createdAt, updatedAt}`；标题 ≤ 200，详情 / 结果 ≤ 4000，验收文本 ≤ 200。
- **成员工具 `group_tasks`**：只挂在群聊成员会话（spawn 命令 `botGroupTasks`，由 `BotSpawnSpec.groupTasks` 在 chat.kind=group 时置位），私聊与委派子会话不挂；`action: list | add | claim | update | complete | cancel`，参数 `id / title / detail / result` 全部声明类型；`prepareArguments` 在 schema 校验前归一化（action 别名与大小写、`taskId`/`task_id` → `id`、数字 id → 字符串、可选键 null 删除）。经 `delegation-invoke`（op=`group_tasks`）进 Main，Main 再校验：开关开启、会话是该成员在该群的当前会话、成员仍在群里且未归档。规则：claim 只认领 `todo` 且无人负责的任务，「读-判-写」在 Main 单线程里一次同步完成，第二个认领返回 `Task #N is already claimed by X.`；complete 只能由负责人完成且必须写 result；cancel 只能由创建者或负责人取消。只读成员同样可以使用全部动作：看板是 Main 内的协调元数据，不涉及工作区文件写入，不突破只读档的边界。
- **与委派打通**：`delegate` 在群聊会话里多一个可选参数 `taskId`（`#N` 或 id）。创建前过闸门：任务必须是 `todo`，或发起人自己认领中且尚无委派；否则拒绝且不建记录。委派记录每次落盘后同步任务（纯函数 `taskAfterDelegation`）：创建 → `doing`、负责人 = 目标、记 `delegationId`；完成 → `done`，result 取委派结果；失败 / 超时 / 中断 / 取消 → 退回 `todo` 并清负责人与 `delegationId`。只有任务仍由这条委派负责时终态才生效。委派进行中的任务成员不能用 `group_tasks` complete / cancel（真机里被委派的成员在群会话里看到「委派给你」后自己标了完成，导致委派被连带取消、卡片显示「已取消」），只能等委派结束自动同步；取消走 `check_delegation`，人类仍可直接完成 / 取消。UI 重试时，任务仍空闲才沿用关联。人类取消 / 完成 / 删除任务、成员离开时，先落新状态再取消关联中的委派，委派终态回写时任务已不归它负责，不会二次改写。
- **人类 UI**：群信息面板「看板」页签，按 待办 / 进行中 / 已完成（默认最近 5 条）/ 已取消（默认折叠）分组；新建、编辑标题与详情、指派、标记完成、取消、删除。指派 = 任务置 `doing` + 负责人，再以人类身份在群里发「@成员 请处理任务 #N：标题」，复用群路由；投递失败回滚任务。
- **群上下文**：新建、认领、完成、取消，以及委派接手 / 完成 / 退回、负责人离开退回，各写一条简短 system 时间线条目（如「阿全 认领了 #3 登录页」），进入其他成员的增量上下文；编辑标题 / 详情不写。system 条目不触发路由。
- **成员提示**：群聊 Bot 模式说明里写明看板的用途（多步工作拆任务、先认领再做、完成写结果、交给别人用 `delegate` 带 `taskId`），并要求不要为每条消息建任务、建前先 list 查重。
- **成员离开**：移出群时其认领中的任务退回 `todo`；删除成员时对所有群执行同样处理。
- **事件与开关**：任务变更推 `BOT_EVENT {kind:'tasks', chatId}`，renderer 只刷新打开过看板的群。botModeEnabled 关闭时 IPC 返回 disabled（列表返回空 + `enabled:false`），worker 侧工具不挂，Main 侧调用一律拒绝。
- **手机端**：本期不做；`tasks` 事件不经 pair 转发，pair 协议不变。

### 压缩后的群协作连续性

成员会话与 Code 共用压缩（用户选的压缩策略照常生效，bot 不覆盖）。群消息按 cursor 增量注入，压缩后早期原话只剩摘要，因此补三件事：

- **`group_history` 只读工具**：与 `group_tasks` 同挂点（spawn `botGroupTasks`，仅群聊成员会话），经 `delegation-invoke`（op=`group_history`）进 Main。参数 `beforeSeq / afterSeq / limit(默认 30，≤100) / query(大小写不敏感子串) / from(成员名或「用户」)`，`prepareArguments` 在 schema 校验前归一化（别名键、`"#12"` 等数字串、limit 夹取、空值删除）。Main 只按会话权威绑定推导 chatId（参数里的 chatId 忽略），并要求是该成员在该群的当前会话；返回 `{seq, at, from, text}`，委派 / 系统条目给简短描述，单条 2000 字、总量 40000 字截断并标注，`hasMore` 指示继续翻页。无 afterSeq 时取最近，只给 afterSeq 时向后翻。botModeEnabled 关闭时 Main 拒绝。
- **压缩触发记忆整理**：Main 收到成功的 `compaction end`（无 error、非 abandoned）时与会话结束走同一入口：bot 会话 `BotMemoryService.distill`（已有水位），Code 会话 `scheduleMemoryDistill(..., { continueFromLastJob: true })`——未给水位时在串行队列里读该会话最近一次 `memory_jobs` 的 `toEntryId` 续作，首个任务仍全量；会话结束蒸馏同样改走续作，压缩后再结束不重复整理前半段。jsonl 不因压缩丢原文，只是提前整理。
- **压缩后补群状态**：群聊成员会话压缩成功后，`GroupChatService` 在内存里给该会话打标记；下一次向该成员投递群增量时在前面追加 `<group-state>`，由 Main 权威数据确定性生成：成员与分工、群主、本轮待回应顺序、进行中委派（谁→谁、任务）、看板未完成任务（#N、状态、负责人）、当前时间线 seq 与 `group_history` 提示；条目 / 条数 / 总长（4000 字）都有上限。已达成的约定由群记忆（chat 空间）承载，不在这里生成。投递成功（含排队）后清标记，失败保留；删群、会话退役、删成员时清标记；重启后标记丢失（可接受，最多少补一次）。私聊不做。
- **手动压缩**：桌面 `AGENT_COMPACT` 对 bot 会话放行（不改执行与策略，忙碌时 worker 排队）；手机 pair 仍拒绝，不加 UI 入口。

### 成员用量与日预算

参考 akeru-bot 单 bot 账本 + 硬上限中断、OpenGrokBot 按员工汇总用量。不新建账本，用量的权威仍是 pi jsonl。

- **归属**：按 `ConversationAuthority.bot.botId` 归集——私聊、群聊、例行任务（投进私聊 / 群聊会话）都记在该成员名下；委派子会话 binding 记的是目标成员，归目标。Code 会话、Code 里拉 bot 当 coworker 的 child 不计入，Code 的按模型 / 按项目统计不变。纯函数在 `shared/usage/botUsage.ts`（同一 jsonl entry id 只计一次）；`services/bots/botUsage.ts` 逐个 bot 会话 `sessionFile` 走用量页的解析缓存（`loadUsageSession`），单价复用用量页同一张表（`getUsagePricing`：catalog + 本地补丁 + 用户覆盖）。tokens = input + output + cacheRead + cacheWrite，与用量页一致。
- **展示**：`BOT_USAGE_SUMMARY(days)` 给用量页「按成员」排行（周期沿用页面选择，仅 botModeEnabled 时显示）；`BOT_USAGE()` 给每个成员今日 / 近 7 天 / 近 30 天 token 与估算成本及今日是否超额，资料面板「资料」页顶部展示，并带今日预算进度。
- **预算**：`BotProfile.budget?: { dailyCostUsd?; dailyTokens? }`，正数才算上限，按本地时区自然日（`startOfLocalDay`）重置；缺省 / 旧数据 = 不限。新建成员与资料「能力」页可填（留空 = 不限，`budget:null` 清除）。未定价模型的成本为 null，不触发成本上限，只能靠 token 上限。
- **执行点**：统一在 `BotSessionHost`。`deliverConversation`（私聊、群聊接力、委派任务、委派结果回投、例行任务都经过）在去重之后、steer / 排队 / 启动之前检查；排队项真正启动前（pump）再查一次。超额返回 `budget-exceeded`，不发给 worker（renderer 不做乐观回显，提示「该成员今日预算已用完」）。运行中：每条 assistant 消息结束（`stopReason` + `usage`，且 live 消息的 `timing.completedMs` 已打上——pi 的流式中间态也带 `stopReason`）后检查，超额则以 `budget-exceeded` 结算并停掉该会话当前回合（与 `stopTurn` 同一路径，清掉它的排队项）。
- **内存账本**：`BotUsageService` 按成员维护今日账本，成员首次判定时读一次它的 bot 会话 jsonl（未设预算不读），之后由宿主在每条 assistant 消息结束时 `record` 增量累计；键为 `conversationId:timestamp`，与 jsonl 记录同键，读盘期间到达的消息先暂存再合并，重复 upsert 覆盖不重复计；跨本地零点只丢弃旧记录、不重读。定价表按自然日缓存。预算端口拆成异步 `prepare`（备账本）+ 同步 `verdict(botId, reservedTokens)`，宿主在 `prepare` 之后同一同步段里判定并占 slot，两个同时到达的回合不会都按「零预留」放行。
- **回合预留**：成员每个进行中回合（slot 或 running）预留 `min(32k, maxTokensPerTurn)` 减去本回合已用；新回合判定 = 今日已用 + 该成员其他进行中回合的未用预留，运行中检查同样只算其他回合的预留（不算自己）。回合结束（slot 释放）预留自然消失，不需要单独释放点。真机：成员日上限 = 已用 + 30k 时同一轮并行委派两件事，第二件在闸口即 `budget-exceeded`，第一件跑到上限附近被停，合计只超最后一条消息。
- **单回合上限**：`BotProfile.maxTokensPerTurn?`（正整数，缺省不限）。宿主按 turnKey 记本回合每条 assistant 消息（按 index 覆盖）的 token：消息结束且有实报用量时取实报；否则估算（`turnTokens.ts`）：input 取已报 input + cache，没报（OpenAI 兼容流式中）取会话最近一次 `session-meta` 的上下文占用 `occupancy.used`，output 取 `max(已报 output, 已出正文 / 可见推理 / 工具参数估算)`，中日韩约 1.5 字/token、其余约 4 字符/token。超过即以 `turn-token-limit` 停掉该回合（同预算停止路径，不打 `stopped`、不级联取消委派）；群里写「X 本回合用量超过单回合上限，已停止」，委派卡片显示超出单回合上限。只算实报用量未超限时为「按估算」停止，`BotTurnFinished.estimated` 让群 system 与私聊通知写「本回合用量（按估算）超过单回合上限」；日预算的运行中检查同样计入本回合未入账的流式估算，不等消息结束。局限：不外露的推理只能在消息结束时补计。真机（上限 12k，input 约 9k）：GLM 流式写长文停在约 1k 推理 + 4.2k 正文，Claude 停在约 0.3k 推理 + 1.9k 正文，短回合不受影响。
- **各入口表现**：群聊写 system「X 今日预算已用完」并跳过该成员继续队列（投递被拒与回合被停都一样；例行任务在群里同样写这条）；例行任务 `lastResult = 'budget'`；委派以 `failed / error` 结束，`error = 'budget-exceeded'`，卡片显示预算用完。拒绝或停止时推 `BOT_EVENT {kind:'budget'}`（不转发到手机），renderer 刷新概览，收件箱按「成员 + 自然日」出现一条可忽略的预算提示（忽略记录在 localStorage）。
- **不做**：成员会话里 subagent 子代理的用量（pi child jsonl 不带父会话标识，无法可靠归属）；私聊没有时间线，不写 system 条目，只有发送提示与收件箱；预算只看今日，不做周 / 月上限。

### 团队模板与导入导出

团队 = 群配置 + 成员档案与人设，统一用 `TeamSpec`（`shared/bots/team.ts`）描述，成员之间的委派关系用团队内 `key` 引用，不含任何本机 id。

- **内置模板**（`renderer/stores/bots/teamTemplates.ts`）：软件开发小队（项目经理 / 前端 / 后端 / 测试审查，默认绑 Code 项目）、内容创作组（主编 / 写手 / 文字编辑 / 排版配图）、调研小组（组长 / 资料搜集 / 分析 / 报告撰写），后两者默认群独立目录。中英双语按界面语言取；群主只读工具、只派不写，其余成员职责互斥；委派是「群主 → 执行者 → 审查者」的单向链，群主不接受委派。人设只按角色称呼队友（名字可能被改）。统一 smart 路由（接力上限 6、每人 2 次）、开启记忆、`auto-edits`；不带模型（跟随默认模型）、技能、MCP。
- **入口与预览**：侧栏 / 窄栏 / 空态「从模板创建团队」→ 选模板或导入 JSON → `BOT_TEAM_PREVIEW`（模板传 `team`，导入传文件原文 `text`，Main 严格校验并按现有成员 + 保留名预先改名）→ 同一预览：改群名、取消勾选成员（群主不可取消，至少 2 人，委派引用随之剪掉）、改成员名（本地即时校验重名）、选工作区（群独立目录 / 绑定本机 Code 项目；导入文件只记录工作区类型）。被自动改名的成员显示「X 已被占用，已改名为 X2」。
- **原子创建**：`BOT_TEAM_CREATE(team, workspace)` 在 Main 里重新校验并再跑一次改名，按序创建成员（key → 预分配 UUID，委派引用换成 id）→ 解析工作区 → 建群（群主 = bossKey）。任一步失败：删除已建成员、撤销新建的群独立目录与 bot-home 项目，返回错误；成功后推 `catalog` + `chat` 事件。
- **重名**：与现有成员（含归档）或保留名（内置 agent 类型、非 bot 来源的 agent 类型）冲突时追加 2、3…，按名称上限截断原名；团队内部也互相避让。
- **导出**：群信息面板「导出团队」。renderer 逐个 `bots.get` 取人设后用 `buildTeamFile` 生成 `{format:'enso-bot-team', version:1, exportedAt, team}`，浏览器下载为 `<群名>.team.json`。只保留群名、群主、工作区类型、路由、成员名 / 头衔 / 职责 / 人设 / 头像颜色 / 工具档 / 审批档 / 委派（群外成员的引用丢弃）/ 记忆开关；剥离记忆内容、会话、时间线、看板、例行任务、预算、模型与 provider、技能与 MCP id、项目 id 与路径。
- **导入校验**：文件 ≤ 256k 字符；`format` / `version` 不符分别报「不是团队文件」/「版本不受支持」；任何层级的未知字段、越界值、非法枚举、非法名字、重复 key、悬空引用、群主不在成员中、成员 < 2 或 > 12 都整体拒绝，不做部分导入。
- **不做**：导出不经 Main 文件对话框（与人物卡导出一致走浏览器下载）；不跨版本迁移；模板不预设技能 / MCP / 模型。

## UI

- **模式切换**：侧栏顶部 NodeSwitcher 旁边放 `Code | Bot` 分段控件，存到 `localStorage['enso-mode']`。只在本机生效：切到远程节点时隐藏切换并回到 Code 视图。快捷键、标题栏按钮、SidePanel 照远程节点的做法按模式屏蔽。
- **BotSidebar**：
  - 私聊区：每个成员一行，显示头像、名字、最后一条消息、未读点、运行中动效；
  - 群聊区；
  - 置顶、归档；
  - 底部入口：新建成员、新建群、收件箱、设置。
- **BotChatView**：
  - 私聊：`MessageTimeline` 渲染该会话，头像和名字用成员档案。
  - 群聊：渲染时间线条目，每条 bot 消息带「查看过程」，展开后内嵌该成员会话这一轮的工具过程（只读）；委派条目显示为卡片，可以取消或重试。
  - 输入框复用 `Composer`，支持 @ 成员补全；工具栏是工作区徽标、成员模型（私聊）、审批档。
  - 必须提供 `ChatHostContext`，避免 retry、fork 落到 Code 模式的当前会话上。
- **BotProfilePanel**（右侧）：人设、头衔/scope、模型、工具/技能/MCP、审批档、工作区、委派权限、记忆、例行任务、历史会话、导入导出人物卡。
- **GroupInfoPanel**（群聊右侧）：与 BotProfilePanel 一样用页签——群信息（成员、回复队列、工作区、路由上限、群记忆）/ 看板（群任务看板）/ 委派（本群委派按 进行中 / 已完成 / 失败·中断·取消 汇总，终态默认最近 5 条，复用委派卡片的取消、重试、查看过程）/ 例行（本群例行任务）。
- **新建成员**：从空白开始、导入人物卡，或者从内置模板（经理 / 全栈 / 运维 / 测试 / 设计）创建。
- Code 模式的 Sidebar、ChatView 只增加一处过滤：`bot-home` 项目和带 `bot` 字段的会话不显示。

## 新增 IPC（通道常量 + Main handler + preload typed 出口）

- `BOTS_LIST / BOT_SAVE / BOT_ARCHIVE / BOT_DELETE / BOT_IMPORT_CARD / BOT_EXPORT_CARD / BOT_AVATAR`（导入走 Main 文件对话框，不接收 renderer 传入的路径）
- `BOT_CHATS_LIST / BOT_CHAT_CREATE / BOT_CHAT_UPDATE / BOT_CHAT_DELETE / BOT_CHAT_TIMELINE(chatId, beforeSeq)`
- `BOT_SEND(chatId, text, attachments, deliveryId)`
- `BOT_DELEGATION_CANCEL / BOT_DELEGATION_RETRY`
- `BOT_ROUTINE_SAVE / BOT_ROUTINE_DELETE / BOT_ROUTINE_RUN_NOW`
- `BOT_TASKS_LIST(chatId) / BOT_TASK_SAVE(chatId, id?, title, detail?) / BOT_TASK_ASSIGN(chatId, id, botId) / BOT_TASK_COMPLETE(chatId, id, result?) / BOT_TASK_CANCEL(chatId, id) / BOT_TASK_DELETE(chatId, id)`：群任务看板，只接受 group 聊天
- `BOT_SUGGEST_ABILITIES(name, title, scope, persona, language, botId?)`：「自动设置能力」。候选技能 / MCP / 成员由 Main 从设置与成员库取；模型链为设置里的「Bot 助理模型」→ 默认模型（不走标题模型），20s 超时；回复严格解析（未知 id 丢弃、枚举校验，没有其他成员时不给委派建议），只返回建议，renderer 逐项确认后写入表单，仍需保存 / 创建。
- `BOT_SUGGEST_PERSONA(name, title, scope?, persona?, language)`：「AI 生成人设」。名称和头衔必填；模型链同上（Bot 助理模型 → 默认模型），30s 超时；输出第二人称人设，职责为空时顺带给出一句职责，已有人设则在其基础上改进。结果直接填进表单，toast 可撤销，仍需保存 / 创建。
- `BOT_TEAM_PREVIEW({team} | {text}) / BOT_TEAM_CREATE(team, workspace)`：团队模板与导入的校验预览、原子创建（见「团队模板与导入导出」）。
- 推送 `BOT_EVENT`：`{kind:'catalog'|'chat'|'timeline'|'delegation'|'routine'|'tasks', chatId?, seq}`，按 chatId 去重，过期 seq 丢弃；`tasks` 不转发到手机。

所有入参都按 `unknown` 收窄。

## 必改文件（主要）

| 层 | 文件 |
|---|---|
| shared | `types/agent.ts`（ProjectKind 加 `bot-home`、ConversationAuthority 加 `bot`）、新 `types/bot.ts`、`characterCard*.ts`、`bots/router.ts`、`bots/transcript.ts`、`ipc` 常量、`i18n.ts` |
| main | 新 `services/bots/*`、`ipc/bots.ts`；`ipc/agent.ts`（persistedRootSpawn 接受 bot-home、spawn 组装 bot 提示词）、`agentHost.ts`、`sourceAuthorityRegistry.ts`、`memory/*`（空间）、`agentTypes`（`bot:<id>`）、`pairHost`/`pairPolicy`/`pairSessionHost`（bot 帧与命令）、`index.ts`（scheduler 启停） |
| agent | `supervisor.ts`（bot 扩展、delegate 工具、结果注入）、`tools/memory.ts` |
| preload | `index.ts` 的 `bots` 出口 |
| renderer | `App.tsx` 模式分支、新 `components/bots/*`、`stores/bots/*`、`Sidebar.tsx`、项目列表和 `stores/pairCatalog.ts` 处的过滤 |
| packages | `pair/src/protocol.ts`（新帧与命令）、`phone`（`client.ts`、`sessionCache.ts`、`SessionDrawer.tsx` 加 Bot 分区、新群聊视图） |

## 明确不做

- 外部消息渠道（Telegram / Discord 等）、语音、远程沙箱、图片生成。
- ssh 项目：不能作为 bot 或群的工作区，也不能在 ssh 项目的 Code 会话里拉成员当 coworker。
- 远程节点（桌面连桌面）：不做 Bot 视图；作为 guest 时收到 bot 帧直接忽略，Code 目录里也看不到 bot 项目和会话。
- 成员之间无人触发的自由讨论（必须由人类消息、例行任务或委派触发，并受 maxHops 限制）。
- 迁移 EnsoBot 分支的数据。
- Code 模式的行为变化（除了上面列出的过滤）。

## 测试与验收

- **Red-Green 覆盖的纯函数**：路由（@ 解析、@所有人、群主兜底、跳数与每人次数上限、系统条目不触发、插话分流与队列丢弃、`[skip]`）、增量上下文（cursor、排除自己、40 条截断、格式转义）、委派策略（深度、并发、目标能力与审批档收紧、群成员限制、只投递一次、重启判失败）、群工作区解析（Code 项目 / 独立目录 / 项目被移除）、人物卡 PNG 读写、cron 计算、IPC 入参校验、记忆空间解析。
- **宿主测试**（临时 userData）：spawn / 恢复 / 改绑工作区（私聊与群聊）；投递失败不推进 cursor，skip 或出错仍推进；worker 退出后恢复；时间线 seq 在重启后不回退；删除群时清理独立工作区。
- **真机**：隔离 userData 和 CDP 端口，至少两个厂商的模型，验证私聊、群聊 @ 链、委派和结果回投、默认审批档下的审批与提问、Code 模式拉 bot 当 coworker、例行任务、重启恢复、手机端私聊和群聊（含审批、Web Push、旧版手机忽略新帧）；确认远程节点看不到 bot 项目和会话。
- 提交前运行 `pnpm typecheck && pnpm lint && pnpm test`。按可独立描述的单元拆提交：数据模型与存储 → 会话宿主 → 群聊 → 委派 → 记忆 → 例行任务 → UI → 手机端。

## 已确认决策

上线：放在「设置 → 实验功能」里，默认关闭；开启后侧栏才出现 `Code | Bot` 切换，关闭时 Code 模式零影响（Main 服务不启动调度器，pair 不下发 bot 帧）。


1. 群聊路由：采用「单一回复人 + @ 接力 + 跳数上限」，而不是多人同时回复。
2. 成员默认工作区：私聊默认用 bot 自己的 home 目录，需要时再绑定 Code 项目。
3. 范围包含例行任务和手机端；不考虑 ssh 项目和远程节点。
4. 委派深度 2、并发 3、超时 4h、maxHops 4、maxTurnsPerBot 2 这几个默认值。
5. 新建群聊时选择工作区：基于 Code 项目，或独立工作区。
6. 参考开源实现后的调整（akeru-bot、Z4YT0N/OpenGrokBot）：人类插话在边界丢弃剩余接力并重新路由；支持 `[skip]`；系统条目不触发接力；cursor 在投递成功时推进。
7. 智能选人（参考 OpenGrokBot 分派器）：不 @ 时可由便宜模型/pi 分类器选 1–3 位成员依次回复（通常 1 人），成员无话可说时回 `[skip]`；新建群缺省开启，旧群保持群主回复；任何失败都兜底群主。

## 实现与验证记录（2026-10-04）

**与设计的差异**

- 委派按目标成员自身能力执行（工具、技能、MCP 取目标配置），审批档取双方更严；是否允许由 `canDelegateTo/acceptFrom` 控制。真机里只读的项目经理委派全栈工程师改文件，按交集执行时子会话只读，委派失去意义。只读父会话的 subagent 子代理仍保持只读。
- 群里委派完成只写一条 delegation 卡片（含结果摘要），不再以被委派成员名义重复写一条 bot 消息。
- 委派结果投递是「至少一次 + 父会话按 delegationId 去重」，`deliveredAt` 在父会话真正开始处理后写入。
- 通用执行与策略入口（prompt / steer / 队列 / 改模型 / 改审批档）对 bot 会话一律拒绝，只能经 Bot 服务投递；abort、审批与提问答复仍共用。
- 群接力每一跳生成新的 deliveryId，只有本轮第一条沿用触发它的 id（否则会被投递去重误判为重复而卡死）。
- 人物卡只做了 JSON（SillyTavern V1/V2）导入导出，PNG 卡片未做。

**真机验证**（隔离 userData，Claude opus + 阿里云 GLM 两家模型）

- 私聊：创建成员、首轮回复、只读成员无 bash、工作区在 `userData/bots/<id>/workspace`。
- 群聊：@ 顺序、无 @ 由群主回复、@ 接力往返、委派与结果回投、群工作区文件读写、重启后恢复「回复被中断」与未投递委派补投。
- 审批：成员改为「全程审批」后在私聊内联出现审批并放行。
- 例行任务：保存、立即运行、Code 模式下触发后切回 Bot 仍能看到新消息。
- Code 模式：`@成员` 补全单独成组，拉成员当 coworker，在 Code 项目目录执行。
- 未在真机验证：手机端（协议与客户端有单测，手机 vite build 通过）、Web Push、桌面通知点击跳转、定时自动触发（只验证了立即运行）。

**压缩连续性真机验证（2026-10-04，隔离 userData，Claude sonnet-4-6 + 阿里云 GLM-5.3，压缩策略 continuous-memory）**

- 两人群聊数轮后对两位成员手动压缩：各自下一次投递带 `<group-state>`（分工、群主、待回应、看板 #1 进行中、当前 seq），之后的投递不再带。
- GLM 成员压缩后调用 `group_history {limit:20}` 找回 seq 1 暗号原话与 seq 9 文案原句；Claude 成员调用 `group_history {query:"按钮颜色"}` 找回 seq 10 原话。
- 压缩后各生成一个蒸馏任务（带 chatId，群约定落 chat 空间）；新增若干轮后再压缩，新任务 `fromEntryId` = 上次 `toEntryId`；紧接着再压缩（Already compacted）不产生任务。

## 聊天全文搜索与产物卡片（2026-10 补充）

参考 opengrokbot-z4 的 ⌘K 搜索（Search.tsx）与产物预览（server/files.ts、Preview.tsx）。

**全文搜索**

- 入口：Bot 模式下 `search-workspace` 绑定（默认 ⌘K，与 Code 模式同一键，按模式分流，Bot 模式打开 `BotSearchDialog`）+ 侧栏 / 折叠栏搜索按钮。
- `BOT_SEARCH({query, limit?})`：query 去空白后 1–200 字符，limit 缺省 50、上限 100。Main 扫描群 `timeline.jsonl` 的 human / bot 条目，以及私聊当前与历史会话（`sessionsOf` → 会话权威里的 `sessionFile`，必须落在 sessions 目录内）的用户 / 助手 text part；大小写不敏感字面子串，空白折叠后围绕首个命中裁 160 字片段并返回片段内全部命中区间；按时间倒序截断并返回 `truncated`。单个时间线 / 会话读取失败只 `console.warn` 跳过。会话全量投影（`projectParentHistoryAll`，下标与历史分页同一编号）按 mtime+size 缓存 16 份，与产物卡片共用。
- 命中定位：群为 `{timeline, seq}`；私聊为 `{session, conversationId, messageIndex, current}`。选中后 store 写 `focus`（带 nonce），目标聊天消费：群时间线目标不在已加载范围内就 `loadAround` 一次取目标前后各 40 条（`beforeSeq=seq+41, limit=81`，不加 IPC 参数）替换列表，没到最新则进入「历史窗口」（`timeline.history`：向上 `beforeSeq`、向下 `beforeSeq=末尾+51` 翻页，追上最新自动退出；实时新消息不并入列表，只更新 lastSeq 与侧栏预览用的 tail，显示「回到最新 · N 条新消息」；已读记号只推进到已加载末尾且不回退；已加载超过 400 条从远离视口的一端裁掉，按视口锚点条目保持滚动位置），布局阶段滚到 `[data-seq]` 并底色高亮 2.5s（2 万条群跳到 seq 123 dev 构建约 0.15–0.5s，翻页单页约 30–40ms）；私聊当前会话按需 `loadOlderSession`，用 `messageItemKey`（`${i}` / `${i}-n`）`scrollToKey` 并复用会话内查找的高亮；历史会话或已换新会话则打开只读历史弹窗做同样定位（私聊列表是 Virtuoso 虚拟化，不会渲染爆炸，但仍逐页 60 条前翻、每页 Main 全量解析一次会话 jsonl，超长会话跳很早的消息会慢，未做窗口化）。

**产物卡片**

- 群 bot 条目下方、私聊（含只读历史）每轮最终回复下方（`ChatHost.turnFooter`，Code 模式不提供即无变化）。
- `BOT_ARTIFACTS_LIST`：renderer 只传 `{chatId, entryId}`（群）或 `{chatId, conversationId, messageIndex}`（私聊）。Main 校验会话 `bot.chatId` 属于该聊天，取该轮消息（群按回复正文定位最近一轮，私聊按下标取两条用户消息之间），候选 = `write` / `edit` 的 `path` + `apply_patch` 已落盘的非删除路径 + 助手正文里的路径（绝对、相对、带扩展名的文件名，`file://` 转路径，网址忽略，`:行:列` 去掉）；工作区根 = 该会话项目的 `canonicalPath`（成员 home / 群目录 / 绑定的 Code 项目，ssh 拒绝）。`realpath` 后必须仍在根内且是普通文件，按真实路径去重，每条最多 8 张。
- `BOT_ARTIFACT_READ` / `BOT_ARTIFACT_OPEN` 同样只收上述标识 + `rel`，Main 重新推导清单，`rel` 必须在清单里，再按根二次 `realpath` 校验。预览：图片 data URL（≤20MB）、Markdown（复用聊天 Markdown）、文本 / 代码、HTML 用 `sandbox=""` 的 `srcdoc` iframe（不执行脚本、拿不到宿主）；PDF 由 Main 开独立窗口（无 preload、sandbox、`plugins` 开内置查看器、禁新窗口与跳转）；其余类型只有「在访达中显示 / 用默认应用打开」。默认应用打开拒绝带执行位或脚本 / 可执行扩展名的文件（只能在访达中显示）。
- 不做：群成员会话里的委派子会话产物、轮次进行中的实时卡片（轮次结束后出现）、搜索委派子会话与系统条目。

真机（隔离 userData，Claude opus-4-6 + 阿里云 qwen3.8-max）：群里两位成员分别写 `notes.md` / `demo.html` / `docs/report.md`，卡片出现，Markdown 与 HTML（含 `<script>`，未执行）预览正常，越界 `rel` 被拒；私聊 qwen 写 `mango.txt` / `logo.svg`（SVG 图片预览）、Claude 用 bash 生成 `sample.pdf`（独立窗口内置查看器）；⌘K 搜到群消息、私聊当前会话与「新对话」后的历史会话，跳转、滚动定位与高亮正常。

## 例行任务生命周期（2026-10 补充）

参考 akeru-bot `packages/contracts/src/routines.ts` 与 `apps/server/src/routines/*`（运行键 `routine:<id>:<scheduledFor>`、草稿审批、试运行跳过审批）。

**数据**

- `BotRoutine` 去掉 `enabled`，改为 `status: draft | enabled | paused | blocked`，新增 `procedureVersion`、`approvedVersion?`、`doneBy?`（执行成员）、`catchUp`（默认开）、`proposedBy?`、`blockedReason?`、`cursor?`（已处理到的调度时刻）。旧数据按 `enabled` 解析为 `enabled / paused`、版本 1 且已批准。
- 标题 / 提示词 / 调度 / 目标聊天 / 执行者变化时 `procedureVersion + 1`；补跑开关、启停不升版本。只有 `approvedVersion === procedureVersion` 且 `status = enabled` 才按调度运行，手动运行还允许 `paused`。
- 用户在 UI 新建 / 编辑即批准当前版本（`approvedVersion = procedureVersion`，清阻塞原因）；成员经 `routine_propose` 新建是 `draft`；同一聊天里同名（不分大小写）视为改动，流程变了则升版本回到 `draft`，未变不写盘。拒绝从未批准过的直接删除，否则转 `paused`（仍未批准，用户编辑保存即批准）。
- 运行历史 `userData/bots/<botId>/routine-runs.jsonl`：一次运行一个 `runId = routine:<routineId>:<scheduledFor>`，同 runId 后写覆盖（开始写占用，结算再写一次），字段 `trigger (scheduled|manual|catchup|dry-run)`、`executorId`、`chatId`、`startedAt / finishedAt`、`result (ok|error|budget|skipped-busy|interrupted|blocked)`、`conversationId`、`error`。超过 1000 行压缩为每个例程最近 50 条（未结算的保留）；删例程同时删历史；删成员随目录删除。

**调度、占用与补跑**

- `runId` 同时是投递的 `deliveryId`。执行前先写占用：同一 `(routineId, scheduledFor)` 已有记录就跳过，杜绝重复执行；同一例程上一次还没结算时到点，写一条 `skipped-busy`（不排队、不重入）；手动 / 试运行遇到运行中直接返回 `busy`。
- 启动时先对账：未结算的占用一律标 `interrupted`（试运行不改例程的上次结果），该时刻不会再补跑。然后对每个可调度例程算 `(cursor ?? lastRunAt ?? createdAt, now]` 内错过的时刻：开补跑时只补最近一次（`trigger = catchup`），其余计入 `missed`；关补跑则全部计入 `missed`。游标前移到最近时刻；下一次正常调度清掉 `missed`。重新启用 / 批准 / 改调度时游标置为当前，暂停、阻塞、待批准期间的时刻不补。
- 手动运行更新上次结果但不动游标；试运行（`dry-run`）对草稿也可用，不改上次结果、游标与错过次数，投递正文带 `dry-run="true"` 属性和一行英文试运行说明，群里 system 条目写「例行任务：X（试运行）」；聊天里的注入卡片显示「例行任务试运行」。
- 投递返回 `duplicate`（该 deliveryId 已被会话处理过）时直接按失败结算，不再等结束事件。

**依赖检查与阻塞**

- 归属成员不存在或已归档：不调度也不能手动运行（沿用「成员归档 = 例行任务暂停」）。
- 每次运行前（含试运行）检查：执行成员存在且未归档、目标聊天存在且未归档、执行成员在聊天里；`doneBy` 另需满足归属成员 → 执行成员的 `canDelegateTo / acceptFrom`。不满足时 `status = blocked` + `blockedReason`，写一条 `blocked` 历史，推 `routine` 事件；草稿试运行失败只返回原因、不改状态。用户保存 / 批准后也立即检查一次。
- 收件箱复用 `routine` 事件：renderer store 拉全量例程，`draft` 与 `blocked` 各出一张卡片（批准 / 拒绝 / 试运行，或原因 + 重新启用），计入 Bot 待处理数；重新启用仍不满足时提示原因。

**成员提议：`routine_propose`**

- 只挂在成员自己的私聊 / 群聊会话（spawn 标记 `botRoutines`，由 `BotSpawnSpec.routines` 在非委派会话置位；委派会话走 independentSpecs，不挂）。参数 `title / prompt / schedule / doneBy?` 全部声明 `string`；`prepareArguments` 在 schema 校验前归一化（`name / task / instructions / cron / when / done_by / executor` 等别名、数字转串、去空白、`doneBy` 去 `@`、null 与空串删除）。经 `delegation-invoke`（op=`routine_propose`）进 Main。
- Main 只认会话权威绑定：有 `chatId`、无 `delegationId`、成员与聊天都未归档、成员在聊天里、且是该成员在该聊天的当前会话；参数里的聊天一律忽略。`schedule` 接受 5 段 cron 或简单描述（`shared/bots/routineSchedule.ts`：每天 / 工作日 / 每周几（可多天）+ 时间、每小时，中英文，`下午 / 晚上` 与 `am/pm` 修正），无法识别返回带示例的错误。`doneBy` 按名字在本聊天成员里找（不分大小写），找不到、已归档或 ACL 不允许都拒绝。
- 结果是待批准草稿；群聊再写一条带 `routine: {botId, id}` 引用的 system 条目（「X 提议了 / 修改了例行任务「T」（每天 10:15，由 Y 执行），等待批准」），时间线据此渲染卡片：仍待批准时可批准 / 拒绝 / 试运行，之后显示当前状态。私聊只进收件箱与资料页列表。

**IPC 与 UI**

- 新增 `BOT_ROUTINE_REVIEW {botId, id, approve}`、`BOT_ROUTINE_RUNS {botId, id}`（最近 20 条）；`BOT_ROUTINE_RUN_NOW` 增加 `dryRun?`，同步预检后返回 `not-approved / blocked(+reason) / busy / unavailable / not-found`；`BOT_ROUTINE_SAVE` 增加 `doneBy?: string | null`（缺省沿用原执行者）与 `catchUp?`，执行成员必须在目标聊天里，ACL 不允许返回 `acl`。入参全部按 `unknown` 收窄。
- `RoutineList`：状态徽标、成员提议提示、阻塞原因、错过次数与「不补跑」标记；草稿显示批准 / 拒绝，其余显示启停开关与立即运行；所有状态都可试运行；「历史」展开最近 20 次（时间、触发方式、结果、耗时、打开聊天、错误）。编辑器调度默认用简单选择器（每天 / 工作日 / 每周几多选 + 时间），可切到 cron 高级输入；新增执行者（目标聊天里的其他成员）与补跑开关。
- 不做：手机端例行任务管理；成员通过工具删除 / 暂停例行任务；保留被拒绝改动之前的旧版本流程（拒绝后需用户编辑或删除）。

**测试**：`routineSchedule`（简单描述与选择器往返）、`parseBotRoutine / parseBotRoutineRun`（旧数据迁移、脏输入）、`BotRoutineRunLog`（覆盖、坏行、压缩、对账源）、`BotRoutineStore`（版本、提议 / 审批 / 拒绝、游标）、`RoutineScheduler`（补跑只一次且重启不重复、关补跑、对账 interrupted、skipped-busy、草稿只可试运行、成员改动回到待批准、依赖阻塞、`routineBlock` ACL）、`RoutineRunner`（执行者身份、派生 deliveryId、试运行标注、duplicate）、`routine_propose` 归一化与 schema、bots IPC（越权会话 / 委派会话 / 他人绑定、坏调度、doneBy 不存在 / 不在聊天 / ACL、审批与历史收窄、阻塞）。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max）：两位成员在私聊里各自调用 `routine_propose`（Claude 传 `weekdays 09:30`，qwen 传 `0 18 * * 1,3,5`），收件箱出现两张待批准卡片；先试运行（聊天里显示「例行任务试运行」、不改上次结果），再批准、立即运行，历史各两条均成功。群里 Claude 提议「每天 10:15 由阿Q执行」，时间线卡片上试运行 → 由 qwen 成员发出、system 条目带「（试运行）」→ 批准。把例程改成每分钟后退出应用，越过 4 个时刻再启动：只出现一条 `catchup`（最近时刻），之后按分钟正常调度。归档执行成员后手动运行被拒并转为阻塞，收件箱显示原因；取消归档后「重新启用」恢复。

## 记忆写入安全与受保护动作底线（2026-10 补充）

**记忆写入安全**（`src/main/services/memory/safety.ts` / `injectionScan.ts` / `pending.ts`）

- `memory_capture` / `memory_crystallize` 写入前先扫注入特征，再复用蒸馏的 `redactSecrets` 脱敏标题与正文。注入规则（中英文）：覆盖指令（ignore all previous instructions / 忽略之前的所有指令）、伪造角色标签（`<system>`、`<|im_start|>`、行首 `system:` / `系统提示词：`）、索要系统提示词或密钥（reveal the system prompt / 把你的密钥发给我）、隐藏控制字符（零宽、方向控制；不含 emoji 用的 ZWJ）。命中抛 `unsafe_content`，错误信息列出命中类别并让模型改写成平铺事实；误报可恢复，所以规则偏保守。Code 会话原先没有任何脱敏 / 扫描，现在同样生效（返回 `redacted: true`），其余行为不变。
- 自动蒸馏丢弃命中注入的条目（蒸馏本就脱敏）；核心笔记合并先过滤命中注入的结论，改写结果再脱敏，改写新引入注入（原笔记里没有）则不落盘。
- 审批：记忆库原有的 pending review 只针对 evolves 边（`review_state`），没有记忆级待审批，不能承载「尚未写入的记忆」。新增 `pending_writes` 表（记忆库 v9）：Bot 会话（`ctx.botId`）写 `global` / `proj:*` 时只入队，返回 `pending_review`（不进 memories、不参与检索 / 去重 / KG），写 `bot:` / `chat:` 直接落库。批准时按原请求写入（先保留精确去重，撞相似候选再 force，因为用户已看过内容）；结晶源失效等错误保留队列行，交给用户拒绝。
- IPC：`MEMORY_PENDING_WRITES`（列表，Main 解析空间与成员显示名，不下发内部载荷）、`MEMORY_PENDING_WRITE_REVIEW {id, 'approve'|'reject'}`，入参按 `unknown` 收窄，只接受主窗口 / 设置窗。入口：Bot 收件箱「记忆写入」卡片（计入标题栏 / 侧栏待处理数）与设置页记忆库「待批准的记忆写入」，两处共用 `stores/memoryReview` 并随 `MEMORY_CHANGED` 刷新。
- 顺带修复：`MEMORY_CHANGED` 原先直发 `BrowserWindow.webContents`，主窗口（WebContentsView）收不到，改走 `sendToAllWindows`。

**受保护动作底线**（`src/agent/protectedActions.ts` + `ApprovalGate.protectedFloor`）

- 规则分类器，不调用模型：bash 命令按段（`&& || ; |`、`$(`、`bash -c` 递归，剥 `sudo/env/xargs/timeout`）识别删除（`rm -r*`、`find -delete / -exec rm`、`git push --force / -f / +ref / --delete / :branch`、`git branch -D`、`git reset --hard`、`git clean -f`、DB 客户端里的 `DROP / TRUNCATE / DELETE FROM`、`kubectl delete`、`terraform destroy`、`dd of=/dev/*`）、部署（`kubectl apply` 等变更动词、`helm install/upgrade`、`terraform apply`、`npm/pnpm/cargo publish`、`docker push`、脚本名或 make 目标含 deploy/release/publish/prod、`vercel` 非只读子命令、`gh release create`、云 CLI 的 deploy）、对外发送（`curl/wget/httpie` 带数据或写方法且目标非本机、非常见包管理源；`mail/sendmail`、`scp/rsync` 到远端、`gh pr/issue create|comment`、脚本里 `requests.post` 等）、付款（支付域名、`stripe ... create`）、密钥（命令或 `read` 工具触及 `.env*`（排除 example/sample/template）、`id_rsa` 等私钥、`*.pem/*.key`、`.aws/credentials`、`.netrc`、`.kube/config`、钥匙串导出）。MCP 工具按名字词元（含读动词 get/list/search… 则放过）。
- 命中后无视审批档位与「本会话总是允许」，跳过代审模型直接等真人；此类审批只能单次放行（`allowSession` 视同 `allow`，UI 隐藏该按钮并显示「受保护：删除」等标签）。`read` 平时免审，只在底线开启且读密钥文件时询问。子会话 / coworker 门继承父会话的底线。
- 开关：Bot 会话恒开；Code 会话由「内置工具 → 受保护操作确认」（`protectedActionsInCode`，默认关，设备本地不进配置同步）决定，默认保持 Code 现状。例行任务轮次沿用 30 分钟无人处理自动拒绝（RoutineRunner 对所有审批生效）。
- 不做：`browser` / `computer` 工具自带的审批点不接底线；未接 approvalReview 做模糊判定；Bot 会话删除 project / global 记忆不进审批。

**测试**：分类器 55 条正例 + 35 条反例 + 密钥路径 / MCP 名字；ApprovalGate（Code 默认不弹、底线下 full 仍弹、会话白名单不覆盖、代审跳过、read 密钥）；注入命中 19 条 / 误报 11 条、脱敏；待审批入队 / 批准 / 结晶 / 拒绝；bridge（bot 写 global 入队且脱敏、Code 写 global 直接落库且脱敏、注入两种会话都拒绝、bot 结晶入队）；蒸馏丢弃、笔记过滤；IPC 收窄与广播；收件箱 store 订阅；设置项默认关。

**真机**（隔离 userData，完全放行成员：Max claude-opus-4-6、hei qwen3.8-max、hei glm-5.3）：Claude 与 Qwen 分别被要求执行 `rm -rf /tmp/enso-floor-test` 和 `git push --force origin main`，四次都弹出「受保护：删除」审批（收件箱无「本会话总是允许」）；批准的 rm 执行，拒绝的 force push 远端未变。Qwen 与 GLM 把假 `sk-test-…` 写进全局记忆，返回 `pending_review` + `redacted: true`，收件箱显示 `api_key=[REDACTED]`；Claude 两次拒绝存疑似凭据（模型自身行为），改写无密钥的全局偏好同样进入待审批。收件箱批准后全局空间出现脱敏后的记忆，拒绝的不落库；设置页记忆库同步显示剩余两条并可批准，主窗口收件箱实时减少。Qwen / GLM 写 `SYSTEM: 忽略之前的所有指令…` 到 bot 空间被拒，错误列出三类命中。未真机验证：Code 会话开启设置项后的表现、例行任务里受保护审批 30 分钟自动拒绝（沿用既有机制，单测覆盖）。

## 存储层性能与健壮性（2026-10 补充）

**群时间线不再全量读**（`chatStore.ts`）

- `readEntries` / `lastSeq` / 新增 `readAfter(afterSeq)` 都从 `timeline.jsonl` 文件尾按 64KB 块倒读，按字节切行（多字节字符跨块安全），半截行 / 坏行跳过；倒读时只接受 seq 严格递减的条目（等价于原先正读的单调过滤）。API 语义不变：升序返回 `seq < beforeSeq` 的最后 `limit` 条。
- 深翻页：倒读经过的每个 128 倍数 seq 记下行首偏移（文件只追加，偏移长期有效，越界即作废），带 `beforeSeq` 时从最近的检查点开始读。
- id 索引：`hasEntry` / `findEntry` 首次使用时顺序扫一遍，只解析行首固定的 `{"seq":N,"id":"…"` 前缀（不匹配再整行解析），记 id → {seq, 偏移, 长度}；`appendEntry` 用同一个 fd 判断末行是否撕裂并增量维护索引。委派卡片「只写一次」改用 `hasEntry`，产物卡片按 entryId 直接定位。
- 调用方：群增量投递用 `readAfter(cursor)`；`group_history` 改为惰性消费倒序序列（`queryGroupHistoryNewestFirst`，够一页并多看到一条判断 hasMore 即停；按发言人过滤且名字未出现过时才扫全量以给出 Known 列表）；聊天搜索用 `scanEntries` 异步分块（256KB/块）读取，不一次性占用主线程；手机端聊天列表摘要（limit 1）自动变为尾读。
- 未做：新成员首次投递（cursor=0）仍需读全量以给出「省略 N 条」的准确计数（一次性，约 10MB/数十毫秒）；时间线条目本身不带 schemaVersion。

**委派结果去重**（`startedDeliveries.ts`）：`hasStartedDelivery` 不再每次读整个会话 jsonl。每个会话文件首次全量扫描，之后只读追加的字节（按 inode + 大小判断，文件被替换或变短则重扫）；末行未写完时能解析就先记下但水位不越过它。jsonl 仍是唯一权威：Main 崩溃重启后新索引从 jsonl 重建，已写入但未确认的结果照样判重。

**jsonl 压缩与归档**：`delegations.jsonl` 与群 `tasks.jsonl` 在加载和每次追加后检查冗余行（被覆盖的旧快照、坏行），达到 `max(阈值, 记录数)`（委派 500、看板 200）时用临时文件 + rename 原子重写为最新快照，失败只 `console.warn` 并保留原文件。看板被删的最大 seq 以一条 `seq-floor` 墓碑保留，`#N` 不复用。已投递（有 `deliveredAt`）的终态委派超过 30 天在加载时移入同目录 `delegations.archive.jsonl`（只追加，不再加载）；归档后旧群里的委派卡片退化为只用时间线条目信息展示，不能再重试 / 查看过程。

**schemaVersion 与迁移**（`shared/bots/migrations.ts`）：`bot.json`、`chat.json`、`routines.json`（文件级 `{schemaVersion, routines}`）、`delegations.jsonl` 每行、`tasks.jsonl` 每条任务快照写入 `schemaVersion`，与乐观并发的 `version` 无关。读盘后 parse 前统一 `migrateRecord(kind, raw)`：缺省按第 1 版处理（旧数据兼容），按步骤数组逐版升级；由更新版本写出的记录不解析（避免有损降级覆盖），jsonl 压缩时原样保留这类行，看板 seq 计入其编号。

**测试**：5 万条尾读正确性与相对耗时上界、跨块多字节 + 半截行、深翻页检查点与无检查点结果一致、id 索引重启后去重、异步扫描；会话 jsonl 增量扫描（追加、半截行、文件替换、原地改写已扫区域不再读到、崩溃重启后宿主拒绝重放）；压缩阈值、加载时压缩与归档、原子重写失败保留原文件、墓碑保 seq；迁移管线、旧数据读取、新版本记录拒绝与压缩保留。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max，群时间线 2 万条 / 9.8MB）：打开 1.8ms；逐页翻到底 199 页共 427ms，单页最大 16ms，期间 Main 探针最大 10ms；学到检查点后深页 2ms。⌘K 搜索 98ms（命中 seq 19990 与 123），宽泛搜索 140ms，期间 Main 探针最大 12ms。两位成员 @ 回复正常；重启后 lastSeq 不回退，增量只投递 cursor 之后的两条。已知未解决：搜索结果跳到很早的条目时，renderer 按页累计渲染数千条时间线条目明显卡顿（renderer 未虚拟化，非 Main 读取问题）。

## 手机离线发送、配对作用域与目标式引导（2026-10 补充）

**手机离线发送队列**（`packages/phone/src/botOutbox.ts`、`OutboxBar.tsx`）

- Bot 发送（私聊与群聊）一律先进队列：IndexedDB 独立库 `enso-phone-outbox`（不和会话缓存同库，免得被其容量淘汰），按 pairId 一条记录存整个队列；deliveryId 在入队时生成，之后重发永远沿用。状态 `pending → sending → 移除/failed`；连接离开 online 时在途项退回 pending，读盘时 `sending` 也按 pending 处理（结果未知，交给 Main 去重）；`failed` 不自动重试，由用户点重试（同一 id）或删除。连上（state=online）即冲刷，不必打开对应聊天。解绑设备时一并删除该配对的队列。
- Main 去重：私聊沿用 `BotSessionHost.deliverConversation` 的 deliveryId 去重（已开始 → duplicate，排队中 → queued）；群聊原先没有去重，现在人类条目 id 取 `human:<deliveryId>`，`GroupChatService.send` 进锁后先 `chats.hasEntry` 判重，重复返回 `{ ok: true, duplicate: true }`，不再落时间线也不再触发路由。
- 断线时群聊发送按钮不再禁用（有队列兜底）；Code 会话发送没有 deliveryId，本次不做离线队列。
- 已知限制：在线状态下若帧被 `PairClient.send` 静默丢弃（极短的 socket 半开窗口），该项停在「发送中」直到下次重连。

**配对作用域**（`packages/pair/src/relay.ts` `PairedDevice.scope`、`src/main/services/pairScope.ts`）

- `scope: 'read' | 'operate'`，缺省（旧记录）与脏值都按 operate；重配对（同 pairId upsert）保留已设的作用域。
- 拦截点在 `pairHost.handleFrame`：`parsePhoneCommand` 通过后、任何分发之前。只读白名单：snapshot / subscribe / history / push-(un)subscribe / presence / direct-* / probe / bot-catalog-request / bot-chat-open / bot-timeline；其余（发送、排队、审批、提问回答、停止、任务/子代理停止、改模型、目标、语音、spawn……以及以后新增的命令）一律拒绝。`bot-send` 被拒时回 `bot-send-result{ok:false,error:'read-only'}`，让手机队列转为失败而不是一直发送中。
- 下发：`host-info` 新增可选 `readOnly: true`（指纹随之变化，切换作用域后 `requestMeta` 即重发）；旧手机忽略该字段，仍会被 host 拦截。新手机收到后隐藏输入框、排队区、目标条、审批/提问条，禁用新建会话，并显示「此设备为只读」。
- 桌面：「设置 → 设备」每台已配对设备显示「可操作 / 只读」徽标，点击切换；新增 IPC `PAIR_SET_SCOPE`（pairId + scope 按 unknown 收窄）。
- 补齐：只读下 TaskBar 仍显示任务 / 子代理但不给停止按钮（`TaskBar.readOnly`），收件箱不给「忽略」、离线队列不给重试，新建会话 / 会话配置面板不打开；其余写命令被拒时 host 回 `command-rejected{command,error:'read-only'}`（`scopeRejection`，旧手机忽略），手机收到它或 `bot-send-result` 的 `read-only` 即置为只读，横幅改为「此设备为只读，刚才的操作未执行」，队列项显示「发送失败：此设备为只读」。真机（headless Chrome 跑手机 PWA dev 连隔离桌面）：后台 `sleep 900` 任务在可操作下有停止按钮、切只读后只剩任务行与横幅，强行发 `task-stop` / `bot-send` 均得到上述提示，切回可操作恢复。
- 未做：作用域只按设备粒度，不细分到会话或 Bot / Code。

**目标式新手引导**（`src/shared/bots/goalSuggest.ts`、`GoalOnboarding.tsx`）

- 入口：Bot 模式没有任何成员时空态直接是目标输入框；侧栏底部与折叠栏新增「从目标开始」按钮，打开同一面板的对话框。
- 推荐：IPC `BOT_SUGGEST_GOAL` 复用 `assistantCompleter`（Bot 助理模型 → 默认模型）与 `runSuggest`（45s 超时、no-model / timeout / invalid-reply）。Renderer 只传目标与内置团队模板的 id/标题/简介；模型回 `{kind:'member', member{name,title,scope,persona}}` 或 `{kind:'team', templateId}`，外加 reason 与 firstMessage。解析容忍外层废话与代码围栏；templateId 必须在传入清单内；成员名剥掉空格与非法字符并截到 24 字符，清理后为空即无效；缺 firstMessage 时回落为目标原文。
- 确认后复用现有创建对话框：成员走 `NewBotDialog`（`seed` 预填为空白来源，可改名、补能力），团队走 `NewTeamDialog`（`seedTemplateId` 直接进入该模板的预览，仍可取舍成员、选工作区）。创建完成回调 `onCreated(chatId)`，`seedBotDraft` 把第一条消息写进该聊天输入框草稿（已挂载的输入框即时更新），不自动发送。

**测试**（27 条）：队列入队/冲刷/在途回退/失败手动重试同 id/重启恢复/恢复与新入队合并/脏数据收窄；群聊同 deliveryId 重放只落一条且只投递一次；作用域缺省值、operate 全放行、read 白名单全矩阵、未知命令默认拒绝、重配对保留作用域；host-info readOnly 下发；推荐提示词、成员 / 团队解析、非法模板、名字清理、坏输入；IPC 入参收窄；suggestGoal 端到端与非法模板。

**真机**（隔离 userData，桌面 dev + 手机 PWA dev 跑在 headless Chrome，经可开关的本地 CONNECT 代理走真实中继，屏蔽 WebRTC 以强制中继）：

- 离线发送：代理断开 → 手机「重连中」，群聊里发送显示「待发送」；断网时刷新页面（模拟杀进程），IndexedDB 中仍是 pending；恢复网络后自动重连冲刷，群时间线出现唯一一条 `human:<deliveryId>`，群主回复 OK。把同一 deliveryId 以 `sending` 写回队列再刷新，重发后队列清空、时间线仍只有一条人类消息。
- 只读：桌面切为只读后手机群聊底部只剩只读提示、输入框隐藏；强行把一条待发项塞进队列，host 日志 `bot-send needs operate scope`，手机项转为「发送失败：read-only」，时间线不变；切回可操作后点重试，以原 id `human:ro-test-1` 落入时间线。设置页徽标点击在「可操作 / 只读」间切换。
- 引导：Max claude-sonnet-4-6 对「每周整理 AI 编程工具竞品简报」推荐单个成员「Vega · 竞品情报分析师」，确认后成员对话框预填，创建后私聊输入框里是起草的第一条消息、未发送；hei glm-5.3 对「记账小程序从需求到测试上线」推荐软件开发小队，确认后进入模板预览，创建团队后群聊输入框预填第一条消息。未覆盖：两家模型各只跑了一条路径（Claude 成员、GLM 团队）。

## 日常体验补齐（2026-10 补充）

**静默看门狗**：`BotSessionHost` 按会话记最后输出时间（任何 worker 事件都算，含工具进度与子代理事件；子会话按 `parent` / `::` 归到根会话），宿主发起的轮次运行中超过 `BOT_SILENCE_MS = 90s` 没有输出即判静默，推 `BotEvent{kind:'silence', chatId?, conversationId}`；恢复输出或轮次结束（完成 / 失败 / 停止 / worker 退出）撤销并再推一次。等待审批 / 提问期间不算静默（答复后重新计时）。巡检是单个 5s 定时器，没有运行中轮次时停掉。`BOT_CHATS_LIST` 附 `silences`，renderer 在私聊头部与群「正在回复」行显示「已安静 X 秒」（每秒刷新），收件箱出现一条，只提示不中断；手机不转发 `silence` 事件（收件箱帧里有）。

**Bot 通知**：`agent.ts` 对绑定 bot 的会话不再走通用 `maybeNotify`（审批 / 提问仍是 `maybeNotifyBot`）。私聊由 `host.onTurnFinished` 发「成员名 · 回复完成 / 回复失败」，正文是回复摘要或错误；用户停止（`canceled`）和委派子会话不报。群聊在 `GroupChatService` 里按批次收集：一条人类消息（或例行任务）引发的整串接力，在没有人回复、没有排队、没有待路由的人类消息、没有排队的例行任务时结束，合并为一条「群名 · A、B 已回复」，正文为最后一条发言摘要与失败成员；`[skip]` 不算参与，用户停止的批次不报。都由 `notifyBotChat` 发出：主窗口聚焦时不弹，点击发 `BOT_EVENT{kind:'open', chatId}`（自动切到 Bot 模式打开聊天）。文案在 `services/bots/botTurnNotice.ts`（Main 不走共享 i18n）。

**渲染层合并刷新**：`stores/bots/coalesce.ts` 按 key 合并约 50ms 内的重复请求（执行中再被请求则结束后补跑一次，失败吞掉）；`refreshChats / refreshDelegations / refreshUsage / refreshRoutines / refreshInbox` 全局合并，`loadLatest / refreshRuntime` 按聊天合并。时间线推送带的 `seq` 不大于已有 `lastSeq` 时不再请求；已有时间线时 `BOT_CHAT_TIMELINE` 带 `afterSeq` 只拉增量（与 `beforeSeq` 互斥），Main 用 `chatStore.readSince`：缺口超过 limit 退回最新一页，renderer 照旧按空洞替换。

**聊天管理**：`BotChat` 增加 `settledAt`（搁置 / 结案）、`snoozedUntil`（稍后提醒）、`pinOrder`（置顶内顺序，只在置顶时保留），复用 `BOT_CHAT_UPDATE`（`settled / snoozedUntil(null 取消) / pinOrder(null 清除)`，按 `unknown` 收窄）。规则在 `shared/bots/chatFlags.ts`：搁置会取消置顶并清顺序；提醒隐含搁置；置顶或回到进行中会取消搁置与提醒。成员有正文回复（非 `[skip]`）或人类在聊天里发言时自动回到进行中。`ChatSnoozeTimer` 用单个定时器指向最早的提醒（远期分段等待，启动时已过期的立即触发），到点取消搁置、推 `reminder`（renderer 标为未读，手机不转发）与 `chat` 事件，并发「稍后提醒 · 聊天名」通知。侧栏新增「已搁置 · N」分组（可折叠，显示「X 后提醒」），右键菜单：搁置 / 回到进行中、稍后提醒（1 小时后 / 3 小时后 / 明天 9:00）、标为未读（已读记号退回一格，只对无未读、非当前聊天显示）、置顶内上移 / 下移；置顶行可 HTML5 拖拽排序，置顶时排到置顶末尾。

**收件箱放到 Main**：`userData/bot-chats/inbox.jsonl`（`BotInboxStore`，append-only 整条快照、按 key 后写覆盖、坏行跳过、冗余达 `max(200, 条目数)` 原子重写，已结束超过 7 天加载时丢弃）。`BotInboxService` 汇总：审批 / 提问（worker 事件，委派会话归到发起委派的聊天并记委托方；解决、回合结束、会话结束、worker 退出时结束）、重启中断且未被重试的委派、今日预算耗尽（按成员 + 自然日，跨日重新判断）、例程待批准（按 `procedureVersion` 建键，改动后重新出现）与被阻塞、静默；后几类各自由权威数据全量 `sync`（`delegation / routine / budget / catalog / silence` 事件触发），新进程启动时上一进程的审批、提问、静默一律结束。同 key 已结束后再出现会重新打开并清掉忽略；未结束的条目忽略状态持久。只有中断委派、预算、静默可忽略（Main 拒绝其它类型 `not-dismissible`）。变化推 `BotEvent{kind:'inbox'}`。

- IPC：`BOT_INBOX_LIST`（read，未结束条目含已忽略）、`BOT_INBOX_UPDATE {key, action:'dismiss'|'reopen'}`（write）。renderer 订阅 `inbox` 事件重拉，`inboxSections` 把条目还原成原有卡片（审批 / 提问卡片用条目里的请求体答复，例程与中断委派卡片取本地权威记录，找不到不渲染）；待处理数 = 未忽略条目 + 待批准记忆写入，为空时入口照旧隐藏。旧版 localStorage 忽略记录首次连上时迁移给 Main 后删除。renderer 里原 `interruptedDelegations / budgetAlerts / routineAlerts / botPendingCount` 等推导移到 `shared/bots/inbox.ts`。
- 手机：上行 `bot-inbox-request`（只读设备可用）、`bot-inbox-dismiss {key}`（需可操作），下行 `bot-inbox {items}`（未结束且未忽略，带 `dismissible`）；目录请求 / 重连时随目录一起下发，变化时整表重推。抽屉 Bot 分段顶部显示「收件箱 · N」，点条目打开聊天，提示类可「忽略」。旧手机忽略新帧。

**测试**：宿主静默（阈值、子代理输出撤销、审批期间不算、停止清理）、群批次合并（[skip]、失败、停止不报）、通知文案与前后台、合并器（合并、执行中补跑、失败不影响后续）、store 合并刷新与 afterSeq / 过期 seq、`readSince` 与入参收窄、聊天标志规则与解析、提醒定时器（过期立即触发、分段、dispose）、IPC 搁置 / 提醒 / 发言唤醒、置顶排序与未读回退、收件箱来源推导、存储（去重、忽略持久、重开、坏行、压缩、过期丢弃）、服务（审批与委派归属、全量同步、忽略校验、重启后结束）、收件箱 IPC、pair 解析与只读作用域、手机帧分发与标签。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max）：两位成员在私聊里各跑 `sleep 100`，约 90s 时头部出现「已安静 9x 秒」、收件箱徽标 1 与静默卡片，命令结束后卡片与提示自动消失（jsonl 中两条静默均有 resolvedAt）。窗口在后台时私聊各弹一条「阿克 / 阿Q · 回复完成」，群里 @ 两人与 qwen→claude 接力各只弹一条「体验群 · 阿克、阿Q 已回复」；在 Code 模式调用通知点击路径切回 Bot 并打开群。接力期间 8 个 Bot 事件只引起 3 次时间线更新，seq 连续。右键上移与真实拖拽（CDP 拦截拖拽）都能调整置顶顺序；搁置后进入「已搁置」并取消置顶，向该私聊发消息即回到进行中；群设 1 分钟后提醒，到点弹「稍后提醒 · 体验群」、回到群聊分组并标为未读；标为未读后侧栏出现未读点。收件箱：Claude 成员改为全程审批后执行 `touch` 出现审批卡片并从收件箱放行（文件写入），qwen 预算 1 token 被拒后出现预算卡片，忽略后重启应用仍为已忽略、`reopen` 后重新出现，去掉预算后自动结束；qwen 用 `routine_propose` 提议的「早报」以待批准卡片出现，忽略被 Main 拒绝，拒绝后消失。未在真机验证：手机端收件箱（协议、解析与客户端有单测）、打包版原生通知的点击跳转（dev 版 macOS 走 osascript 无点击，点击路径直接调用验证）。

## 可验证完成条件（2026-10 补充）

委派和群看板任务可带可选验收条件 `check: { kind: 'output-contains', text }`（text 去首尾空白后 1–200 字，仅此一种）。思路借鉴 EnsoBot 的 `canFinishTask`：成员说「做完了」不算数，要在工具输出里看到约定的文本。

**判定**（`shared/bots/taskCheck.ts` 纯函数 `checkPassed`）：读成员会话 jsonl 当前分支投影（`readBotSessionMessages`，worker 是同步追加写，`turn-completed` / 工具调用时已落盘），只看起点之后的 `toolResult`，**按 toolCallId 取最终一条**——最终是 `isError` 的不算，中途出现过的 PASS 不能沿用（EnsoBot 的经验）；`delegate / check_delegation / group_tasks / group_history / routine_propose` 这类协作工具会回显任务与验收文本，不算证据；助手正文不算。投影单条文本有 32KB 截断，超长输出靠后的文本可能看不到。

**委派**：`delegate` 新增可选 `check`（schema 声明完整 object 类型；`prepareArguments` 在校验前把字符串归一化为 output-contains、null / 空串删除，`output_contains` 写法也接受）；带 `taskId` 且未传 check 时沿用看板任务的 check（`tasks.gate` 返回）。子会话收到的 `<delegation-task>` 里附 `<acceptance-check>` 说明条件。子会话本轮正常结束时异步读日志校验（起点 = 委派 `createdAt`，子会话是专用会话），读完重新取记录、仍进行中才落终态；读失败按未通过。通过 → `completed` + `check.passed:true`；未通过 → **`failed` + `failure:'check'`** + `check.passed:false`，`error` 为「验收未通过：未在工具输出中看到「…」」，`result` 仍保留子成员的回复。回合本身失败不做校验，照旧 `failure:'error'`。

为什么用 `failed` 而不是 `completed + passed:false` 或新状态：现有状态集与手机协议（`PairDelegationState`、时间线 `delegation` 条目的 state/summary）不用改；重试链（只允许 failed / canceled）、看板联动（非 completed 退回待办）、批次合并（终态即齐）都天然成立；收件箱的中断提示只看 `interrupted` 不受影响。回传父会话为 `status="failed"`，正文是验收说明 + 空行 + 子成员回复（`delegationResultBody`）；批次等待提示写「验收未通过」。重试沿用 check。

**看板任务**：`group_tasks` add / update 可带 `check`，update 改 check 只限创建者（防止负责人改条件绕过）；人类在看板新建 / 编辑里填写，`BOT_TASK_SAVE` 收 `check?: string`（≤200，编辑时空串 = 清除；文本不变时保留上次校验结果）。claim 与人类指派记 `claimedAt` 并清掉上次的 passed。带 check 的任务由成员 complete 时，Main 先异步读该成员在本群当前会话的日志，再同步重新校验状态并判定（起点 = `claimedAt`）；不通过拒绝 complete，返回 `Acceptance check failed (验收未通过：…): …`，通过则 `check.passed:true`。人类「标记完成」不校验。关联委派的任务按委派结果流转：通过 → done 并记通过；验收未通过 → 退回 todo，`result` 记未通过原因，`check.passed:false`。成员 list 看到 `check` 文本与 `checkPassed`。`group_tasks` 的 complete 因此可能返回 Promise，`agent.ts` 的 `delegation-invoke` 统一 `Promise.resolve` 后回 worker。

**UI**：看板任务卡与 `DelegationCard` 显示「验收条件 <文本>」与通过 / 未通过徽标（`CheckBadge`）；退回待办且未通过的任务 result 底色为红；委派卡失败说明为「验收未通过：未在工具输出中看到「…」」。手机端不改。

**测试**：判定纯函数（起点、按 toolCallId 取最终、错误覆盖 PASS、协作工具与正文不算）、解析与归一化、工具参数归一化与 schema、委派通过 / 未通过 / 读失败 / 起点前输出 / 继承任务 check / 回合失败不校验 / 重试沿用、看板 complete 拒绝与通过、创建者才能改 check、人类直接完成与清除、指派记认领时间、委派联动状态机、gate 带出 check、`BOT_TASK_SAVE` 入参收窄。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max-0902）：Claude 成员委派 qwen 成员运行 `echo XYZ_PASS`、check=XYZ_PASS → completed、通过；qwen 成员委派 Claude 成员运行 `echo HELLO_ONLY`、check=NEVER_SEEN_42 → failed/check，父会话收到 `status="failed"` 且正文以「验收未通过：未在工具输出中看到「NEVER_SEEN_42」」开头，qwen 如实转述。看板：人类建任务 #1（check=BOARD_OK_7）指派 qwen，qwen 先直接 complete 被拒（list 输出里虽有 BOARD_OK_7 但不算证据），跑 `echo BOARD_OK_7` 后 complete 通过；任务 #2（check=FAIL_MARK_9）由 Claude 带 taskId 委派 qwen 跑 `echo OTHER_TEXT`，委派继承 check 并以验收未通过结束，#2 退回待办、result 记原因、卡片显示「未通过」。

## 工作区写锁、插话补充与排队优先级（2026-10 补充）

都在 `BotSessionHost` 的投递 / 出队路径上，并发上限与预算检查不变。

**工作区写锁**：同一工作区真实路径上，`tools = 'all'` 的成员会话同一时间只有一个在跑轮。键由 Main 从会话权威记录推导（`conversation.projectId → project.canonicalPath` 再 `realpath`，按会话缓存），不收 renderer 路径；写权限看会话实际生效的档案（委派会话为收紧后的档案）。不另存锁表：持锁者就是「有活轮（slot / running）的写会话」，轮次进入终态（完成、失败、停止、中断兜底、会话退休、worker 退出）锁自然释放，进程重启全部清空。
- 投递时工作区被别的写会话占着：进队列等待（`queued`），委派与例行任务照常排队不算失败，委派时限照常计时；`onlyIfIdle`（委派结果回传）按 `session-busy` 拒绝、下一次回合结束再投；私聊重试同样按忙拒绝。出队时跳过仍被占的等待者，锁释放后只放行队首一个（它一占位，后面同目录的继续等）。
- 不受锁影响：只读成员（不占也不等）、同一会话自身的多次投递、steer 进当前活轮。
- 群聊（或发起委派的群）里第一次因工作区等待时写一条 system「等待 X 释放工作目录」，同一条投递只写一次。
- **委派不死锁**：委派会话在父工作区干活，父轮可能在委派后继续跑（甚至轮询 `check_delegation`）。`registerDelegation` 记下来源（父会话、群），同一条委派链上的祖先 / 后代共用锁：子委派借用祖先持有的锁照常开跑，父会话之后的新轮也不被自己的子委派挡住；兄弟委派之间、与链外会话之间仍互斥。重启后委派全部中断，重新登记的委派父会话是只读，不涉及锁。
- 顺带：出队时 slot 占位保留到预算账本备好之后才让出，避免 await 期间别的投递抢走并发位与写锁。

**插话补充说明**（`shared/bots/interject.ts`）：来源为 human 的投递 steer 进运行中的轮次时，正文前加「这是同一件事的补充，保留原目标，把它并进这一轮的结果；不要单独回一句『收到』。只有明确说换掉或取消才改目标。\n补充内容：\n」（界面语言非中文用英文版，Main 读 `settings.language`）；笔记更新块仍在最前。群接力、委派任务与结果、例行任务原样 steer。`stripBotNotesUpdate` 顺带剥掉这段说明，气泡、草稿回填、聊天引用摘录都不显示。会话收到 `turn-retry`（自动重试倒计时）后到下一个 status / 回合终态之前，插话不 steer（worker 的 steer 会打断重试改起新轮），改排到下一轮作为新 prompt。

**排队优先级**（`shared/bots/lane.ts`）：`BotDeliverOptions.source`：`human`（私聊 / 群里人发、看板直接指派）> `bot`（群接力、委派任务、委派结果回传，缺省值）> `background`（例行任务），入队时按来源插到同级末尾，同级先来先出；`queueState` 的位置即出队顺序。群首个投递沿用触发来源，之后的接力一律记 `bot`。

**测试**：`botSessionHost.lock.test`（同目录只放行一个、唤醒一个、只读 / 不同目录 / 同会话 steer 不受阻、worker 退出清锁、`onlyIfIdle` 按忙、群提示只写一次、父轮仍在跑时子 / 孙委派开跑、兄弟委派互斥且父新轮等子写完、重试按忙），`botSessionHost.delivery.test`（人类插话包装与非人类原样、英文与笔记块顺序、重试倒计时插话排下一轮、重试恢复后 steer、出队优先级），`interject` / `lane` / `notes` 纯函数；委派相关旧用例改为符合写锁的顺序（`groupDelegation` 全员只读，只验证接力与回传）。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max-0902，同一 Code 项目工作区）：阿克私聊跑 `sleep 20` 写日志时，阿Q 私聊投递返回 `queued`，群里 @阿Q 也排队并出现一条「等待 阿克 释放工作目录」；日志顺序为 K start/end → Q start/end → G，全程只一条提示。阿克委派阿Q 后在本轮里 `sleep 5` + `check_delegation` 轮询，子委派在父轮仍在跑时即开跑完成，父轮第一次查询即拿到 completed；反过来阿Q（qwen，用 codemode 轮询）委派阿克同样即时开跑。两人各自 `sleep 15` 写诗时插话「诗里要提到月亮」：jsonl 里该条 user 消息带补充说明前缀，两位都在同一轮结果里写进月亮、没有单独回「收到」；私聊气泡只显示原话。未在真机验证：自动重试倒计时（需要上游瞬态错误）与出队优先级（需要占满并发），由单测覆盖。

## 正在回复行内嵌进度与排队原因（2026-10 补充）

> 2026-10 起「工作区写锁」改为下文「同工作区写协调」：整轮锁已移除，排队原因不再有 `workspace`。

**行为**：群时间线「XX 正在回复」行（点击仍打开实时会话弹窗）与私聊输入框上方的状态条直接显示：状态（排队中 / 思考中 / 输出中 / 调用工具 / 重试中）、本轮已运行时长（每秒刷新）、本轮最近 3 个工具步骤（工具名 + 单行参数摘要 ≤80 字 + 运行中 / 完成 / 出错 / 已拒绝 + 耗时，运行中按 `toolStartedAt` 实时计），更早的折成「+N」。

**数据**：不新增快照推送。运行态全部来自 renderer 已订阅的成员会话投影（`stores/bots/liveActivity.ts` 纯函数）：本轮 = 最后一条 user 消息之后；`retry` → 重试中，有未收口工具 → 调用工具，末条 assistant 以正文结尾 → 输出中，其余思考中；拒绝只认精确文本 `User denied this operation`。排队原因由 Main 的 `queueState()` 按项计算并随 `BOT_CHATS_LIST` 返回：`BotQueueItem.reason` = `turn`（同会话上一轮未结束 / 前面已有同会话投递）> `workspace`（带 `holderBotId`，只发成员标识不发路径）> `capacity`（并发名额满）。`pump()` 结束时比较各聊天排队原因签名，出队之外原因变化（如并发位让出后改等工作目录）也补发 `queue` 事件。预算超限是直接拒绝不排队，没有对应原因。私聊排队时不再显示「等有空闲会话名额」的输入框提示（与状态条原因冲突）。手机协议不变。

**测试**：`botSessionHost.lock.test`（工作目录原因带持锁成员、同会话为 turn、并发满为 capacity、原因变化补发事件），`liveActivity.test`（空闲 / 排队、本轮最近 3 步与 +N、出错 / 拒绝 / 耗时 / 截断、思考 / 输出 / 重试）。

**真机**（隔离 userData，Max claude-sonnet-4-6 + hei qwen3.8-max-0902，同一项目工作区）：群里 @阿克 分 5 次跑 bash，行内依次出现「思考中 → 调用工具 · sleep 3 运行中 2.3s → 完成 3.2s」，第 4 步起显示「+1」「+2」，计时逐秒递增；@阿Q 分 4 次跑 bash，最后 `cat no_such_file.txt` 显示「出错」。阿克私聊跑 `sleep 30` 时群里 @阿Q，行内显示「排队中 · 等待 阿克 释放工作目录」，阿克结束后阿Q 开跑；私聊同样场景状态条显示同一原因，开跑后切为思考中 / 调用工具与步骤。

## 图片头像与 PNG 人物卡（2026-10 补充）

**头像**：`BotProfile.avatar.image` 为 `userData/bots/<botId>/avatar.png` 写入时的成员 version（有图标记兼缓存版本），`color` 恒保留作底色与兜底。新增 `BOT_SET_AVATAR {botId, image: Uint8Array | null}`：Main 校验 PNG / JPEG / WebP 魔数且 ≤ 2MB（`shared/bots/cardPng.ts` 的 `checkAvatarImage`），`BotStore.setAvatar` 原字节写入或删除文件并 bump version；草稿更新只合并颜色，图片只经此通道变更。Renderer 侧裁切统一输出 512×512 PNG，所以文件名固定 `.png`；Main 不转码（无需 nativeImage / WebP 解码），读取时按魔数给 Content-Type。归档不动文件，彻底删除随成员目录一起删。

**显示**：复用 `local-image://` 特权协议的保留 host `bot-avatar`：`local-image://bot-avatar/<botId>?v=<image>`，Main 经 bots 注册的解析器按 botId 推导路径（`isBotId` 校验、档案无图返回 404），Renderer 不接触磁盘路径；URL 带版本号，换图即换 URL，可长缓存。`BotAvatar` 有图时叠 `<img>`（加载失败回落首字），所有调用处自动生效；私聊 / 历史 / 实时会话的回复头经 `ChatSpeaker.image` 显示。手机协议不变（仍只发颜色）。

**上传与裁切**：`AvatarCropDialog`（拖动平移、滚轮 / 滑块缩放，圆形取景，canvas 输出 512 PNG data URL）。新建成员时先暂存预览，创建成功后再写入；资料面板「上传头像 / 移除头像」即时生效。

**PNG 人物卡**：导出改为 SillyTavern V2 PNG：图用头像（无图画颜色圆 + 首字），`tEXt chara` = base64(UTF-8 V2 JSON)，`description` = 人设，`scenario` = 职责，`creator_notes` = 头衔；`extensions.enso` 放 `title / scope / color / tools / approvalMode / memory`，不含技能 / MCP id、模型、委派名单。写入时替换已有 `chara` 并删除 `ccv3`，CRC 正确。导入支持 PNG（优先 `chara`，其次 `ccv3`）与 JSON；带 `extensions.enso` 时人设取 `description` 原文并还原专有字段，否则沿用 description + Personality + Scenario 拼接；卡图居中裁成方形作头像。

**测试**：`cardPng.test`（CRC 标准值、tEXt 写在 IEND 前且 CRC 正确、替换不重复并删除 ccv3、坏输入、base64 UTF-8 往返、魔数与大小上限），`characterCard.test`（导出字段映射与排除、自导出卡还原、非法专有字段逐项忽略），`botStore.test`（写入 / 版本 / 编辑与归档保留 / 移除），`bots.test`（入参收窄、协议按 botId 寻址、删除成员清理文件）。

**真机**（隔离 userData，fake provider）：上传 800×600 图拖动 + 缩放裁切后创建成员，侧栏、私聊头部与空态、资料面板、私聊回复头、群头像、群时间线、群信息均显示图片，`avatar.png` 为 512×512；导出 PNG 的各 chunk CRC 正确，再导入得到相同的头衔 / 职责 / 人设 / 颜色 / 工具 / 审批 / 记忆与头像；300×450 SillyTavern 卡导入后人设按拼接规则生成、头像为居中 512 方图；移除头像后文件删除、回落颜色；SVG 与超 2MB 被拒；归档成员头像仍可加载，彻底删除后 404，`..%2F` 路径 404。

## 同工作区写协调：文件级占用 + 全局命令短独占（2026-10 替换整轮写锁）

**动机**：整轮写锁让同目录里改不同文件的写成员也只能排队。

**行为**（`src/agent/workspaceClaims.ts`，在 agent worker 进程内，全部会话共享一个 `WorkspaceClaims`）：
- 写工具（edit / write / apply_patch）在审批通过后、执行前按目标文件（真实路径，不存在的文件按最近存在的祖先目录取 realpath）登记占用，持有到本轮结束（turn-completed / turn-failed；会话释放时一并清掉）。别人占着同一文件时在工具调用内等待，最长 2 分钟，超时以工具错误告诉模型「X 正在改这个文件，本轮结束释放；先做别的文件或协调后重试」。
- bash 里影响整个仓库的命令（git commit/checkout/switch/reset/rebase/merge/pull/stash/cherry-pick/revert/restore/clean/am/apply/mv/rm，npm/pnpm/yarn/bun 的 install/add/remove/update 等，`rm -r`，含 `sh -c` 嵌套与 `&&`/`;` 串联）只在命令执行期间独占工作区：等其他会话的文件占用全部释放才开始，执行期间别人的写工具等待，命令结束立即释放。普通 bash、读工具、只读成员不参与。
- 等待开始时经工具的流式更新推一句 `Waiting: …`，工具卡片与实时会话里可见。
- 委派链上的祖先与后代互不阻塞（父轮常在等子委派结果）；兄弟委派、链外会话之间按文件 / 全局命令互斥。
- 远程（ssh）工作区不参与。

**Main 侧**：`BotSessionHost` 删除整轮写锁（`workspaceHolder` / 等待提示 / `onlyIfIdle` 与重试按忙），写成员（`tools = 'all'`）spawn 时带 `writeLock = { label: 成员名, ancestors: 委派链祖先会话 }`，经 `spawn-parent.botWriteLock` 下发（协议校验 label 非空、ancestors 为非空字符串数组）。`BotQueueReason` 只剩 `turn` / `capacity`。

**已知取舍**：两人互相等待对方持有的文件或「一人占文件、另一人要跑全局命令且自己也占着文件」会互等到超时，由超时打破；后台运行的全局命令只在前台启动阶段独占。

**测试**：`workspaceClaims.test`（不同文件并行、同文件等待释放、委派链不互阻、超时信息与只提示一次、中止、不同工作区、全局命令等文件释放且执行期间阻塞写、命令识别正反例、两种工具包装），`botSessionHost.lock.test`（同目录写成员直接开跑、spawn 带名字与祖先、只读不带、`onlyIfIdle` 与重试不再按忙、排队原因 turn / capacity），`agent.test`（`botWriteLock` 协议校验）。

**真机**（隔离 userData，同一 git 项目，alice = Max claude-opus-5-5，bob = Grok grok-4.7-build-fast，两个私聊并发）：alice 写 shared.txt 后 `sleep 40`；bob 同时写 b.txt 立即完成（不排队），随后改 shared.txt 的 apply_patch 在 17:52:40 发出、等到 alice 本轮结束 17:52:51 才落盘。alice 新建 c.txt 后 `sleep 30` 期间，bob 的 `git commit` 在 17:53:52 发出、17:54:16 才执行（alice 17:54:15 结束）。

## 手机端成员实时运行态（2026-10 补充）

**动机**：手机群聊只有「XX 正在回复…」，看不到成员在干什么，委派子会话完全不可见。

**协议**：新增下行帧 `bot-activity { now, items: PairBotActivity[] }`，整表、变化才推（500ms 节流，`bot-event queue` 也触发），连接 / 重同步时随目录一起发。每项 = 正在跑或在排队的 Bot 会话：`conversationId / botId / chatId`（委派会话取发起委派的聊天）/ `ownerBotId`（委派发起者）/ `state`（queued | thinking | typing | tool | retrying）/ `reason`（turn | capacity）/ `startedAt` / 最近 3 个工具步骤（名、参数摘要 ≤80、状态、耗时或开始时刻）/ `more`。`now` 为 host 时钟，手机按 `本机 − now` 换算计时，不受两端时钟差影响。旧手机与远程节点忽略该帧。

**Main**：`BotActivityTracker`（`src/main/services/bots/activityTracker.ts`）从 `forwardAgentEvent` 的事件流维护 Bot 会话本轮状态，只留最后一条 user 起的消息；`status ≠ running` / turn-completed / turn-failed / worker-exited 清掉，未在跑的会话收到迟到消息不复活；快照里正在跑的会话补齐本轮消息。计算复用桌面同一个纯函数 `shared/bots/liveActivity.ts`（由 renderer 挪到 shared，`detailOf` 一起挪）。`pairActivityItems` 合并运行态与 `queueState()`，非 Bot 会话丢弃。

**手机**：群聊时间线底部为每个运行 / 排队中的成员（含委派子会话「bob 替 alice」）一张卡片：状态、本轮计时、最近步骤（运行中转圈、完成、出错、已拒绝 + 耗时），点开进入该会话只读「过程」视图（委派子会话也能看）；抽屉里聊天行的摘要换成「成员：工具 参数」/ 状态。见过的会话 → 成员缓存，委派结束后过程视图仍显示成员名。

**测试**：`activityTracker.test`（运行 / 步骤 / 完成清除、新一轮丢旧步骤、重试、失败与 idle、accept 过滤与快照、迟到消息、forget 与 worker 退出），`pairBotFrames.test`（去 step id、排队补原因、未知会话丢弃），手机 `botState.test`（状态文案、一行摘要、按聊天筛选排序、耗时格式）、`client.test`（帧分发与时钟差、缺 now 丢弃）。

**真机**（隔离 userData，桌面 dev + 手机 PWA dev 经 enso-relay-dev 配对，alice = Max claude-opus-5-5，bob = Grok grok-4.7-build-fast）：群里让 alice 逐条跑 5 个 bash 并委派 bob 跑 3 个：手机同时出现两张卡片，alice「+2 个更早的步骤、ls ✓ 0s、sleep 8 ✓ 8s、cat nofile.txt ✗」，bob「替 alice · 调用工具 22s、sleep 12 转圈逐秒计时」；抽屉行显示「alice：bash sleep 8」；点 bob 卡片进入委派子会话过程，结束后标题仍为「bob · 过程」；回合结束卡片消失。
