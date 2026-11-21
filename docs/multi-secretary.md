# 多秘书设计

> 状态：已定稿并实现。分支 `feat/multi-secretary`，基于 `origin/main`（含 #297）。
> 第一节的行号以 `75964ccc7` 为准，是改造前的现状。

## 目标

1. 可以新建多个秘书。秘书多于 1 个时，侧栏秘书板块整块可折叠，交互与「临时会话」板块、项目分组折叠一致。
2. 每个秘书绑定自己的联系方式；秘书之间可以互相沟通；有一个总工作台 / 看板，每个秘书也有自己的工作台 / 看板。
3. 同一个 Telegram bot 可以给多个秘书用，按 chat / 群 / forum topic 区分，路由不冲突。

## 非目标

- 秘书之间共享可编辑的看板、共享记忆。
- 主秘书：没有「主秘书」概念，所有秘书地位相同。
- 改变单秘书用户的任何可见行为：只有一个秘书时，界面、数据、联系方式全部保持现状。

---

## 一、现状：单秘书假设清单

### 1. 档案与设置

| 位置 | 现状 |
| --- | --- |
| `src/shared/types/secretary.ts:12` | `SecretaryProfile` 没有 id；name、avatar、takeoverScope、visibleProjectIds、maxRunningDispatches、patrolEnabled、notify、dailyBriefAt 全是单份 |
| `src/main/services/secretary/store.ts:32` | `userData/secretary/{profile.json, persona.md, avatar.png, dispatch.json, todos.json, schedules.json}`，一个目录 |
| `src/main/services/secretary/profile.ts:310-315` | `secretaryDir()` 写死 `userData/secretary`，`store()` 只给一个 `SecretaryStore` |
| `secretaryDir()` 另有 5 份拷贝 | `dispatch.ts:2665`、`cleanup.ts:1066`、`following.ts:251`、`daily.ts:103`、`schedules.ts:320`；`readers.ts:512`、`ipc/secretary.ts:216`、`notifications.ts:212`、`ipc/secretaryContact.ts:153` 直接拼 `userData/secretary` |
| `src/main/services/secretary/enabled.ts:5` | 全局总开关 `secretaryEnabled`（`settings.json`，`renderer/stores/settings/types.ts:199`），本机字段，不进配置同步（`configSync/index.ts:114`），`configCli/policy.ts:14` 只豁免这个名字 |
| `src/shared/secretary/parse.ts:174-176` | `maxRunningDispatches` 缺省 3（1..10），`patrolEnabled` 缺省 true，按单档案解析 |
| `src/main/services/notifications.ts:206-212` | 通知渠道固定 `'secretary'`，图标取唯一档案的头像 |
| `src/main/services/secretary/prompt.ts:24-80` | 系统提示词读唯一的 profile / persona，名字、范围、语言都来自它 |

### 2. 秘书目录

| 内容 | 位置 |
| --- | --- |
| 审计 | `audit.ts:7-11` → `userData/secretary/audit.jsonl`（5MB 轮转） |
| 按天结果 | `dailyLog.ts:54-57` → `daily.jsonl` |
| 手机关注 | `following.ts:126-142` → `following.json` |
| 联系方式 | `contact/store.ts:11` → `contact.json` + `contact-token.bin`（safeStorage） |
| 自有 skills / tools | `skills.ts:289`、`customTools.ts:403` → `userData/secretary/workspace/{skills,tools}` |
| 投递队列、提案、点名、转交提问 | 全部内嵌在 `dispatch.json`（`shared/types/secretary.ts:419-445` 的 `SecretaryDispatchFile`），`deliveries.ts:19-28` |
| 隐藏项目 | `ipc/agent.ts:1686` 启动时只 `ensureSecretaryProject(userData/secretary/workspace)` 一次；`sourceAuthorityRegistry.ts:70,226-240` 按 `secretary:<canonicalPath>` 幂等登记——**身份键本来就按路径，天然支持多个** |
| 私有记忆 | `memory/space.ts:108` `secretaryPrivateSpace(ctx)` = `projectSpaceId(ctx.projectId)`，即 `proj:<秘书项目 id>`——**按项目区分，天然支持多个**；`profile.ts:326-335` 清记忆时用 `secretaryProjectId()` 取唯一项目 |
| 记忆空间命名 | `ipc/memory.ts:728-729,769-781,814-815` 按 `kind === 'secretary'` 识别，名字写死「秘书」 |

### 3. 秘书项目与秘书会话的识别

| 位置 | 现状 |
| --- | --- |
| `src/main/services/secretary/identity.ts:9-15` | `secretaryProjectId()` 取**第一个** active 的 secretary 项目 |
| `identity.ts:5,17` | `isSecretaryProject` / `isSecretaryConversation` 只看 `kind`，分不出是哪个秘书 |
| `src/main/ipc/agent.ts:2196-2201` | 工具门禁 `isSecretaryProject(project)`，以调用会话 id 作 `secretaryConversationId` 传给 `invokeSecretaryOp`（`services/secretary/tools.ts:15-36`）——工具上下文已按会话区分，可由会话反推秘书 |
| `agent.ts:563,610-645,2049-2058` | spawn 装配（工具描述、系统提示词、记忆可读项目）读唯一 profile |
| `src/main/services/secretary/sessionFactory.ts:35,146` | 派出会话的 `secretaryOrigin` 只有 `{ secretaryConversationId }`，没有秘书 id |
| `src/renderer/lib/secretaryEntry.ts:12,32` | `latestSecretaryConversation(projectId, …)`、`secretaryConversationIds(projectId, …)` 接单个 projectId |
| `src/renderer/lib/openSecretary.ts:10-18` | 折叠侧栏的秘书按钮只打开「那个秘书」的最近会话 |
| `src/renderer/stores/secretary.ts:20-22,108-118` | store 是单个 `SecretaryState`，`projectId: string \| null`，新建秘书会话只用它 |
| `src/shared/types/secretary.ts`（`SecretaryState`） | `projectId`、`profile`、`board`、`takeovers` 都是单份 |
| `src/renderer/components/chat/Sidebar.tsx:192-194,313-340` | 只渲染一个秘书分区；`SECRETARY_COLLAPSED_KEY = 'enso-collapsed-secretary'` 折叠的是这个秘书的会话列表；默认显示 3 条 |
| `src/renderer/components/secretary/SecretarySidebarSection.tsx:18-19,34-152` | 把 secretary 项目从普通项目列表滤掉，单行伪项目 + 折叠按钮 |
| `src/renderer/components/app/HeaderSessionTabs.tsx:152-156` | 用 `secretary.projectId ===` 判断秘书标签 |
| `src/renderer/lib/sidePanelDock.ts:208-217`、`sidepanel/SidePanel.tsx:330` | 「是不是秘书项目」布尔判定（这处多秘书下仍成立） |
| `src/renderer/stores/sessions/secretaryOwned.ts:12` | `isSecretaryOwned` 只问「有没有秘书管」，不问「哪个秘书」 |

折叠状态的现有存法（多秘书沿用同一套）：

- 临时会话板块：`Sidebar.tsx:191` `SCRATCH_COLLAPSED_KEY = 'enso-collapsed-scratch'`，localStorage `'1'/'0'`，读写 `:276-302`。
- 项目折叠：`'enso-collapsed-projects'`，`Record<projectId, boolean>`，`:262-275,582`。
- 项目分组折叠：`'enso-collapsed-project-groups'`，`Record<groupId, boolean>`，`:393-405`。
- 秘书分区：`'enso-collapsed-secretary'`，`'1'/'0'`，`:315-331`。

### 4. 派发、看板、回传、巡检、清理

| 位置 | 现状 |
| --- | --- |
| `shared/types/secretary.ts:319-322` | `DispatchRecord.secretaryConversationId` 记了发起会话，但没有秘书 id |
| `store.ts:105-111` | 只有一份 `dispatch.json` |
| `dispatch.ts:538`、`:598-611` | `runningCount()` 数全部派出记录，上限取唯一 profile 的 `maxRunningDispatches`；`policy.ts:237` 判定 `running >= max` |
| `shared/types/secretary.ts:436-445` | `inflight` 是**单槽**：一次只有一批在途投递 |
| `deliveries.ts:58-80` | `resolveTarget(preferred)`：发起会话已归档 / 删除时，回落到**所有** secretary 项目里最近活跃的会话——多秘书下会错投 |
| `deliveries.ts:85-128,176-230`、`host.ts:786,796,814` | 按单个 `inflight.secretaryConversationId` 判断「这批是不是投给它」，多秘书并发投递会互相阻塞 |
| `host.ts:315,371,396,422,463,548,1106` | 结果、遗留、巡检的 update 取 `record.secretaryConversationId`（按记录，正确） |
| `relay.ts:57-66` | ask-relay 回报目标取 `dispatched[c].secretaryConversationId`，没有记录时交给 `resolveTarget` 的「最近活跃」兜底 |
| `host.ts:643-707` | `runPatrol()` 扫全部记录，开关取唯一 profile 的 `patrolEnabled` |
| `host.ts:957`、`host.ts:1079-1080` | 系统事件、重启收尾的投递目标 |
| `cleanup.ts:334-339` | `scanCleanup` 扫**全部** active 本地项目，不看秘书可见范围；`:911-946` 提案绑发起会话 |
| `results.ts:435,570` | `buildBoard` / `takeoverViews` 只吃一份 dispatch 文件 |
| `dispatch.ts:2643` | `loadSecretaryBoard()` 装配唯一看板 |
| `schedules.ts:43,222-342` | 定时归属会话写 `secretaryConversationId`，文件只有一份 |
| `dispatch.ts:1155,1303,1354,2589` | `latestSecretaryConversation()`：范围接管、界面授予接管、界面派发待办时，归属取「全局最近的秘书会话」 |
| `dispatch.ts:2533` | 界面操作 `{ secretaryConversationId: null }`，无归属 |
| `renderer/components/secretary/SecretaryWorkbench.tsx:513-559` | 直接读 store 的唯一 `board` |

### 5. 联系方式

| 位置 | 现状 |
| --- | --- |
| `contact/store.ts:14-45` | `ContactFile` 单数：`bot`、`chat`、`bind`、`pollOffset`、`telegramGroups[]`、`syncMirror` 等 |
| `contact/telegram.ts:175-196` | 一个 `TelegramChannel` 一个 `ContactPoller`、一个 offset；`threads` 是 chat → 最近话题，全局共享 |
| `contact/poller.ts:99-140` | `getUpdates` 长轮询，无 webhook |
| `telegram.ts:142-152,699-706` | 已识别 forum topic（`topicOf` → `Peer.topicId`），但不参与路由也不持久化 |
| `channel.ts:72-86`、`telegram.ts:349-362,566-614` | 文字出站（回复、提问、确认卡、审批通知、typing）已经带 `topicId`；图片 / 文件上传不带，靠 `threads`（`telegram.ts:178,441-455`）猜「这个 chat 最近的话题」 |
| `telegram.ts:154-167` | `admitChat`：只认绑定的 chat；群要在白名单里且发送者是绑定的人；`:683,721-730` 其他一律丢弃并审计 `contact_inbound_rejected` |
| `telegram.ts:206-209` | `peerId()` 只返回绑定的那个 chat；`service.ts:451-473` `connectedPeers` / `pushTargets` 由它派生——推送目标只有一个 |
| `telegram.ts:268-315`、`:652-679`、`:729-760` | 绑定码：`bind()` 生成（`shared/secretary/contact.ts:33`，TTL 10 分钟），只认私聊 `/start <code>`，5 次失败清码；`completeBind` 只写一个 `chat` |
| `ipc/secretaryContact.ts:160-163` | 入站目标 `secretaryConversationId: () => resolveTarget(delivery)`——**手机永远对着「最近活跃的那个秘书会话」**，最硬的一处单例 |
| `service.ts:1437` | 入站消息落到 `ports.secretaryConversationId()` |
| `service.ts:350,370,482,1105-1169,1461-1472` | `awaitingReply` 按会话记 peer；`commandPeer` 单值 |
| `service.ts:1397-1413,1686-1707,1918` | `/last`、`/sync`、`/following` 与菜单都读「那个」秘书；`ipc/secretaryContact.ts:209,228` 面板数据取唯一看板与 `secretaryProjectId()` |
| `ipc/secretaryContact.ts:305` | 解绑是全清 |
| 插件渠道 | `shared/extensionPlugins/manifest.ts:253,579-599,1018-1022` 声明；`pluginHost/host.ts:512-541,619` `contact.register/inbound/setStatus/call`；`contact/plugins.ts`、`pluginChannel.ts:57-105` 只有 `peerId`，无话题；`docs/plugins.md:395-402` 约定「插件自己只放行绑定的那个人」。微信 Clawbot 是外部插件，本仓库只有夹具 |
| token 冲突 | 只有 renderer 提示 `enso.telegram` 插件可能抢同一个 bot（`SecretaryContactPanel.tsx:105,395`），Main 无校验 |

### 6. 接管关系

- 规则唯一实现：`src/shared/secretary/policy.ts:72-86` `takeoverRefusal()`——`Object.hasOwn(file.dispatched, id) || row.secretaryOrigin !== undefined` 时返回 `already-managed`。单秘书下「已经有秘书在管」等价于「本秘书在管」，所以只查本份 `dispatched`。
- 操作权限：`policy.ts:12-14` `canOperate`、`:40-54` `operateSource`（派出 / `named` 逐个授权 / `takeoverScope` 范围），调用点 `dispatch.ts:1176` `checkTakeover`、`:1215-1237` `checkOperate`。
- 范围接管建记录：`dispatch.ts:1295-1303` `trackScopeSession`；界面授予：`:1335-1356` `grantTakeover`，归属都回落到 `latestSecretaryConversation`。
- 用户收回：`untracked`（`policy.ts:28-33`）、`dispatch.ts:1411` 从 `named` 移除。

多秘书下这些全都只看「本秘书」的文件，两个秘书可以各自把同一会话派出 / 接管 / 点名，规则失效。

### 7. IPC 与 preload

- `src/shared/types/ipc.ts:20-92` 全部 `secretary:*` 通道无秘书维度；`src/main/ipc/secretary.ts:402-438` 一次注册；`src/preload/index.ts:379-421` 出口里只有 `referenceConversations(secretaryConversationId, ids)` 带会话 id。全仓无 `secretaryId`。

### 结论

秘书的全部状态落在一个目录 `userData/secretary/`，由它登记成唯一 `kind: 'secretary'` 隐藏项目；这个 projectId 同时是会话归属、私有记忆空间、侧栏入口键。能直接复用的有两点：**隐藏项目身份按路径**、**记忆空间按项目**，所以「一个秘书 = 一个目录 = 一个隐藏项目」可以几乎零迁移地成立。

---

## 二、数据模型

### 秘书实体与注册表

```ts
/** userData/secretary/secretaries.json，Main 独占读写，原子写 */
interface SecretaryRegistryFile {
  version: 1;
  secretaries: { id: string; createdAt: number; order: number }[];
  /** 全部秘书合计的进行中派发上限，缺省 10 */
  maxRunningTotal?: number;
}
```

- `secretaryId`：`^[a-z0-9][a-z0-9-]{0,31}$`。旧数据迁移出的秘书固定为 `default`，新建的用 `s-<8 位随机>`。
- 目录**不落盘**，由 Main 从 id 推导（`registry.ts` 的 `secretaryDirOf`），杜绝路径注入：
  - `default` → `userData/secretary/`（原地不动）
  - 其他 → `userData/secretary/members/<id>/`
- 每个秘书目录结构与改造前完全一致：`profile.json`、`persona.md`、`avatar.png`、`dispatch.json`、`todos.json`、`schedules.json`、`audit.jsonl`、`daily.jsonl`、`following.json`、`contact.json`、`contact-token.bin`、`workspace/{skills,tools}`。**联系方式也按秘书存**，每个秘书只用自己的 bot 与绑定。
- 全局文件只有 `secretaries.json`，放在 `userData/secretary/` 根下。`getUpdates` 游标存在各秘书自己的 `contact.json`（`pollOffset`）：同一个 bot 的几个秘书取最大的那个继续轮询，推进时每个都写回自己的文件，不另建全局游标文件。`default` 的目录与根目录重合，文件名不冲突。
- 隐藏项目：启动时对每个秘书 `ensureSecretaryProject(<dir>/workspace)`，得到 `secretaryId ↔ projectId` 映射，只存在内存。项目身份按路径，重启后 projectId 稳定。
- 私有记忆空间仍是 `proj:<projectId>`，每个秘书天然独立；记忆空间名显示秘书名字。
- 名字：同一台机器上秘书名字唯一（大小写不敏感），新建与改名时由 Main 校验。
- 没有主秘书。需要「一个秘书」的入口（折叠侧栏按钮、快捷键）一律打开**最近用过的秘书**：所有秘书会话里 `lastActiveAt` 最新的那条。

### `SecretaryContext`

Main 内所有秘书服务改为显式接收 `{ id, dir, projectId }`：

- 各模块原来的单例端口（`secretaryDispatchPorts`、`secretaryProfilePorts`、`secretarySchedulePorts`、`secretaryDailyPorts`、skills、tools、cleanup、readers、following）改成 `xxxPortsFor(ctx)` 工厂，服务实例按秘书缓存。
- `secretaryProjectId()` 删除，换成 `registry.byProject(projectId)` / `registry.byConversation(conversationId)`；`isSecretaryProject` 保留（仍只看 kind）。
- 工具调用：`invokeSecretaryOp(op, params, ctx)` 的 `ctx` 带 `secretaryId`，由 Main 用会话权威反推，不信任 renderer 与模型参数。
- `DispatchRecord`、`PendingDispatch`、`SecretaryProposal`、`SecretarySchedule` 不加 `secretaryId`：它们按秘书分文件存放，所在文件就是归属。
- 派出会话行的 `secretaryOrigin` 增加 `secretaryId`（新写入必带；旧数据缺省视为 `default`）。
- 每个秘书一个回传宿主（`createSecretaryHost`）：各自的定时器、巡检、投递槽位、定时任务，agent 事件广播给全部宿主，各自只处理自己记录里的会话。

### 迁移

原则：**不搬文件、不改旧文件格式**，只新增。

1. 启动时读 `secretaries.json`；不存在则在内存中合成 `{ secretaries: [{ id: 'default' }] }`，**只有在用户新建第二个秘书时才落盘**，单秘书用户的磁盘完全不变。
2. `default` 继续用 `userData/secretary/` 和 `workspace/`：隐藏项目身份、会话 cwd、私有记忆空间 id、skills/tools 路径、`contact.json` 都不变。
3. `secretaries.json` 损坏：备份成 `secretaries.json.bad-<时间>`，按「`default`（根目录有 `profile.json` 或 `dispatch.json` 时）+ 扫描 `members/*/`」重建，不丢秘书。
5. 侧栏 localStorage：旧键 `enso-collapsed-secretary` 的值作为 `default` 的单秘书折叠状态继续生效。
6. 降级：旧版本取第一个 active secretary 项目，`default` 的项目最先登记，降级后主数据仍是它；多秘书数据被旧版本忽略。

### 删除秘书

- 任何秘书都能删，没有不可删的秘书。
- 删除前 Main 生成预览：它正在管的会话（派出与接管）、待办、定时、联系方式绑定（bot、私聊、群、话题、插件渠道）、私有记忆条数。界面列出后要**二次确认**才删。
- 删除时：停掉它的回传宿主与联系方式（释放全部路由，同一 bot 没人用了就停轮询）；它管理的会话变为无人管理——派发记录随秘书文件删除，会话行上的 `secretaryOrigin` 清掉，会话本身不删；它自己的秘书会话与隐藏项目一起移除；私有记忆空间删除；目录删除（`default` 只删属于它的文件，根目录的全局文件保留）。

---

## 三、侧边栏

- 只有一个秘书：与改造前完全一致，不出现分区标题。
- 多于一个：

```
▾ 秘书 · 3            ＋        ← 分区标题：整块折叠；＋ 新建秘书
   ▾ ● 小安 (2)   ⚙ ＋          ← 每个秘书一行伪项目，沿用 SecretarySidebarSection
        今日安排
        重构登录那件事
   ▸ ● 阿财                     ← 单个秘书折叠
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

- 整块折叠：新键 `enso-collapsed-secretary-group`，`'1'/'0'`，写法与 `SCRATCH_COLLAPSED_KEY` 相同。折叠后标题行显示合计角标。
- 单个秘书折叠：新键 `enso-collapsed-secretaries`，`Record<secretaryId, boolean>`；`default` 缺省时读旧键 `enso-collapsed-secretary`。
- 多个秘书时，单个秘书折叠后行首仍是头像。折叠箭头平时不显示，悬停或键盘聚焦到这一行才叠在头像上，不挤动头像和文字；整块标题「秘书 (n)」的箭头则常显，样式与「临时会话」分组一致。只有一个秘书时维持原来的样子：箭头在悬停时顶掉头像，折叠后只留箭头。
- 顺序按 `secretaries.json` 的 `order`，新建的排最后。
- 折叠侧栏的图标列与快捷键：打开最近用过的秘书的最近会话，角标是全部秘书合计。
- 「新建秘书」进入该秘书的欢迎页（复用 `SecretaryWelcome`）。
- 派出会话的「由秘书派出」徽标显示归属秘书的名字。

---

## 四、联系方式

### 原则

- **每个秘书只用自己绑定的联系方式收发**。哪个 bot、chat、话题、插件渠道绑了哪个秘书，就由哪个秘书收、从哪里发；秘书之间不共用，没有兜底秘书。
- 每个秘书在自己的 `contact.json` 里配自己的 Telegram bot token（safeStorage 加密，不进日志与审计）。不同秘书可以填同一个 token。
- **一个 token 一个轮询**：`TelegramHub` 按 token 维持唯一的 `getUpdates` 长轮询，按 chat + 话题把更新路由给订阅它的秘书渠道。不同 token 各一个轮询。
- 冲突键：`bot id + chat id + 话题`。同一个键只能属于一个秘书。

### 每个秘书的路由

`contact.json` 在原有字段上增加：

```ts
interface ContactFile {
  // 原有：bot、chat（私聊）、bind、telegramGroups（群白名单，只收不推）、开关……
  /** 只绑了群或话题、没绑私聊时的主人（Telegram 用户 id）；私聊绑定时就是 chat.id */
  ownerId?: number;
  /** 用绑定码绑到群或话题的路由：收发都走这里 */
  telegramRoutes: { chatId: string; topicId?: string; title?: string; boundAt: number }[];
}
```

一个秘书在一个 bot 上的路由 = 私聊 `chat` + 群白名单 `telegramGroups`（整群）+ `telegramRoutes`（整群或话题）。旧文件没有新字段，读出来等于空，行为不变。

### 入站

```
getUpdates（每个 token 一个）
  → 绑定码消息（/start <码>、/bind <码>，可带 @bot）：交给码匹配的那个秘书；都不匹配时给所有等码的秘书记一次失败
  → 其他：(chat, 话题) 精确路由 → (chat, 整群) 路由 → 命中的秘书走原有逻辑（只认主人）
  → 没有任何路由：不响应、不提示，只在共用这个 bot 的秘书审计里各记一条 contact_inbound_rejected
```

- 话题路由优先于整群路由：同一个群的整群和某个话题可以分给不同秘书。
- 按钮回调按它所在消息的 chat + 话题路由。
- 进到秘书后的处理（提问、确认卡、关注、只读命令、`/last`、`/sync`）都是这个秘书自己的。

### 绑定码

码仍是一次性、10 分钟、5 次失败作废，属于生成它的那个秘书：

1. 私聊：私聊 bot `/start <码>` 或点 `t.me/<bot>?start=<码>`。写 `chat`。
2. 整个群：点 `t.me/<bot>?startgroup=<码>` 把 bot 拉进群（Telegram 在群里发 `/start <码>`），或在群里发 `/bind@<bot> <码>`。
3. forum 话题：在目标话题里发 `/bind@<bot> <码>`。

在群里绑定时：已有主人就只认主人，没有主人就把发码的人记为 `ownerId`。写入前做冲突检查（同一 bot 下所有秘书的私聊、群白名单、路由），冲突时拒绝并只记审计，不在群里回话；成功后在原话题回一句「已绑定到秘书 X」。群白名单（界面里手填群 id）加群时同样做冲突检查。

### 出站

- 推送目标按秘书：私聊（如果绑了）+ `telegramRoutes` 里的群和话题（带 `message_thread_id`）+ 这个秘书拥有的插件渠道的联系人。群白名单只收不推，保持旧行为。
- 回复、正在输入、图片、文件只回消息来源的 chat + 话题；图片和文件上传不再猜「最近话题」，用 peer 自带的话题。
- 一个推送路由都没有的秘书：不借任何别人的渠道，只发桌面通知。

### 插件渠道（微信 Clawbot 等）

- 一个插件渠道同一时间只属于一个秘书：在某个秘书的联系方式页打开它，它就是这个秘书的；别的秘书已经打开时拒绝（冲突键：渠道 id + 全部联系人）。`default` 的旧开关原样保留。
- 插件协议不变，入站按渠道归属分发给拥有它的秘书，没人拥有时不响应只记审计。

---

## 五、秘书之间的沟通

### 机制

两个秘书工具（加入 `SECRETARY_OPS` 与白名单）：

| 工具 | 作用 |
| --- | --- |
| `secretary_list` | 列出同事：id、名字、一句话人设。不列对方的可见项目、会话、看板 |
| `secretary_message { to, text, asTodo? }` | 给另一个秘书发一句话；`asTodo: true` 时同时在对方待办里加一条（标注来自谁），这条待办完成或出问题时自动给发起方回一条系统消息（不计跳数） |

- 投递：写进目标秘书的 outbox，`kind: 'peer-message'`，走现有投递队列（合并、去重、重投），目标会话是对方最近活跃的秘书会话。
- 注入格式：`<secretary-message from="小安" fromId="default" chain="…" hop="2">…</secretary-message>`，正文按不可信内容包裹；系统提示词说明同事的话是请求不是用户指令。
- 秘书间消息不推手机，进动态与审计。

### 防循环

- **链路由 Main 判定**：一个秘书回合如果由 `peer-message` 投递触发（在途批次里有它），这一回合发出的 `secretary_message` 自动继承那条链的 `chain` 与 `hop + 1`；用户或系统事件触发的回合开新链（hop = 1）。
- 每条链最多 4 跳，第 5 跳返回 `chain-limit`。
- 每对秘书（有向）每小时最多 20 条，单个秘书每 10 分钟最多 30 条，超出返回 `rate-limited`。

### 防权限放大（降权回合）

由 `peer-message` 触发的回合，Main 在工具层强制：

- 可见项目取接收方与链上所有发起方的**交集**：`project_*`、`session_list`、`session_read`、`repo_status`、`memory_search`（项目空间）都按交集过滤。
- 接管范围同样取交集；写操作（派发、发消息、停止、接管、清理）的目标项目必须在交集内。
- 点名授权只来自用户；秘书间消息里出现的会话 id 不构成授权。
- 自主度按接收方自己的设置。

---

## 六、工作台与看板

- **单秘书看板**：`buildBoard` 输入换成该秘书的 dispatch + todos，逻辑不变。
- **总看板**：Main 合并全部秘书的看板，每张卡片 / 待办带 `secretaryId`（只在投影里加），分组规则不变。
- **入口**：多秘书时秘书面板顶部出现「本秘书 / 全部」切换，「全部」下可按秘书筛选；只有一个秘书时不出现。
- **IPC**：所有按秘书的 `secretary:*` 通道最后一个参数是 `secretaryId`；只有一个秘书时可省略。新增 `secretary:list`、`secretary:create`、`secretary:delete-preview`、`secretary:delete`、`secretary:transfer`、`secretary:overview`，`secretary:state-changed` 每个秘书各推一份并带 `secretaryId`。提案确认 / 拒绝只传 `proposalId`，Main 在各秘书文件里定位。
- **归属规则**：
  - 派发记录、待办、定时、结果：存在发起秘书的目录里。
  - 界面上无归属的操作（从看板派发待办等）：归看板所在的秘书。
  - 结果回传：先投记录里的发起会话；它已归档或删除时，回落到**同一秘书**最近活跃的会话，不跨秘书；该秘书没有会话时只更新工作台。ask-relay 同理。
  - 巡检、遗留任务、停滞检测、定时：每个秘书按自己的设置扫自己的记录。
  - 清理列表：只扫该秘书可见项目；会话项只列自己的记录；分支 / worktree 被任何秘书的进行中派发占用时标 `blocked`。
  - 进行中上限：每个秘书各自 `maxRunningDispatches`，另有全部合计上限 `maxRunningTotal`（默认 10）。

---

## 七、接管与转交

- 一个会话同一时间只归一个秘书管理。Main 按全部秘书的派发记录与会话行 `secretaryOrigin.secretaryId` 判定归属。
- `takeoverRefusal` 新增 `managed-by-other`（带对方名字）；本秘书已管理仍是 `already-managed`。
- `operateSource`：会话被别的秘书管理时直接无权限，优先级高于点名与接管范围；两个秘书的接管范围覆盖同一项目时，谁先真正用上归谁。
- 用户点名一个被别的秘书管理的会话：不加入点名名单。
- 认领（检查 + 写记录）在 Main 一个同步段里完成，不会两个秘书同时认领成功。
- **转交**：会话界面与工作台卡片提供「转交给…」。Main 把派发记录、挂起的转交提问从 A 的文件移到 B 的文件，清掉 A 对它的点名与待投更新，改写会话行的 `secretaryOrigin.secretaryId`，两边各记审计，B 收到一条「X 把这个会话转交给你」的回传。

---

## 八、实现顺序

一次在本分支完成，按依赖顺序分几个提交，每个提交都过 `pnpm typecheck && pnpm lint` 与相关单测，最后跑全量 `pnpm test` 与 `node scripts/verify-secretary.mjs`。

1. **实体与迁移**：`registry.ts`、`SecretaryContext`、各模块端口工厂、`secretaryOrigin.secretaryId`、按秘书的宿主。单秘书行为不变。
2. **多实例与归属**：IPC 带 `secretaryId`、新建 / 删除（预览 + 二次确认）、回传不跨秘书、合计上限、清理范围、接管唯一、转交。
3. **联系方式**：每个秘书自己的 bot、`TelegramHub`、路由、群和话题绑定码、冲突检查、未绑定不响应、插件渠道归属。
4. **秘书间沟通**：`secretary_list` / `secretary_message`、链与跳数、限速、降权回合。
5. **界面**：多秘书 store、侧栏分区与折叠、新建 / 删除、设置页按秘书、总看板筛选、转交。

验收（`scripts/verify-secretary.mjs` 新增段落，原有段落全部保留）：旧数据原样可用、两个秘书结果各回各的、接管对方会话被拒、转交、侧栏整块折叠刷新后保持、总看板筛选、假 Telegram 下两个话题各进各的秘书、同一 bot + chat + 话题重复绑定被拒、未绑定的完全不响应、一个 token 只有一个轮询、两个 token 各一个轮询、删除秘书的提醒与二次确认、秘书间消息第 5 跳被拦、范围取交集。

---

## 已定决策

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 秘书数量上限 | 8 个 |
| 2 | 进行中派发上限 | 每秘书各自上限 + 全部合计上限（默认 10，存 `secretaries.json`，不进 `settings.json`） |
| 3 | 主秘书 | 没有主秘书。每个秘书只用自己绑定的联系方式收发，私聊也是绑了谁归谁、没绑不归任何人；折叠侧栏按钮与快捷键打开最近用过的秘书 |
| 4 | 没有推送路由的秘书 | 不借别人的渠道，只发桌面通知 |
| 5 | 在未绑定的群、话题、私聊里说话 | 完全不响应、不提示，只记审计 |
| 6 | 同一群的整群与话题分给不同秘书 | 允许，话题优先 |
| 7 | 秘书互读私有记忆 | 不能，只靠 `secretary_message` |
| 8 | 同事请求触发的动作 | 降权回合（可见 / 接管范围取交集）+ 接收方自己的自主度 |
| 9 | 删除秘书 | 不要求移交；删除前列出它管的会话、待办、定时、联系方式绑定与记忆，二次确认后删除；它管的会话变为无人管理（会话不删），路由一起释放 |
| 10 | 每个秘书各自的 Telegram bot | 支持。同一 token 全局一个轮询，按 chat + 话题路由；不同 token 各一个轮询；冲突键 bot + chat + 话题；token 存 safeStorage，不进日志与审计 |
| 11 | 总工作台入口 | 秘书面板「本秘书 / 全部」切换，多秘书时才出现 |
| 12 | 会话在秘书之间转交 | 支持 |
| 13 | 「派给另一个秘书」 | `secretary_message` + `asTodo` 在对方待办里落一条，不做共享看板 |
| 14 | 秘书名字唯一 | 唯一，大小写不敏感 |
