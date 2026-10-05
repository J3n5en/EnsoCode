# 群聊按轮次快照与一键撤回 — 方案（v2）

> 状态：方案，未实现。分支 `feat/bot-mode`。
>
> v2 修订（适配 `7d534802c` 同工作区写协调改为按文件占用）：v1 的前提「同一工作区轮次串行、after 快照写完才放行下一个写会话」已失效——整轮写锁已删，多个写成员可在同一工作区并发跑。轮次改动不能再用整树 `diff(before_T, after_T)` 求得，改为**按文件占用记归属**：
>
> | 项 | v1 | v2 |
> | --- | --- | --- |
> | 改动归属 | 轮前/轮后整树 diff | worker 占用文件时上报，Main 按文件拍 pre / post；整树快照只用于发现「未归属改动」 |
> | worker | 不改 | `workspaceClaims.ts` 加上报钩子与 try-claim；新增 worker 协议事件 / 命令 |
> | 写锁时序 | `release()` 等 after 快照落盘才 `pump()` | 不再碰 pump；改为 worker 的文件占用等 post 快照应答后才释放 |
> | 撤回时有人在写 | 工作区有写会话即拒绝 | 只看本次要动的文件：被他人占用或有全局命令在跑即拒绝；撤回期间占用这些文件 |
> | bash 直写 | 落在整轮 diff 里 | 全局命令按执行窗口整树 diff 归属；普通 bash / 后台命令无法精确归属，只检测并提示，不撤回 |
> | 体积控制 | 复用 10MiB / 200 文件阈值 | 另加每轮、每群总量上限；被 ignore 的占用文件不入库 |
> | 工作量 | 约 6 人日 | 约 8 人日 |

## 1. 当前行为与目标差距

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 粒度 | `src/agent/checkpoint` 每会话每轮首个写工具前拍一次整树，ref `refs/enso-checkpoints/tool-<sessionId>-<ts>` | 每群每轮：成员、轮次、改动文件及其 pre / post 内容 |
| 并发 | `workspaceClaims.ts`：写工具按文件占用到本轮结束，全局命令执行期间独占；同工作区多个写会话并发 | 并发轮次的改动按文件分开记，互不污染 |
| 还原 | `restoreCheckpoint` 整树 `reset --hard` + `read-tree -u` + clean | 只反向应用某一轮的文件改动，保留其他轮 / 用户的改动 |
| 群聊 | 群聊 rewind 被 `ipc/bots.ts` 以 `direct-only` 拒绝 | 群级索引，可在群里撤回任意一轮 |
| 非 git | `CheckpointManager` 静默禁用；chat-home 工作区通常不是 git | 非 git 目录同样可快照 |
| 清理 | `pruneStaleCheckpoints` 删 7 天前所有 refs | 随群生命周期管理，删群即删 |

不能复用 `restoreCheckpoint`：整树还原会抹掉其他成员并发或之后的改动（`checkpoint-cross-session-wipe.md` 同类问题）。

## 2. 改动归属：按文件占用记到当前轮

### 2.1 原理

占用保证同一文件同一时刻只有一条委派链在写，且持有到该轮结束。所以对文件 f：

- **pre_T(f)** = T 首次占用 f、工具执行**之前**的内容；
- **post_T(f)** = T 结束、占用释放**之前**的内容；
- 下一个占用 f 的轮次 U 有 pre_U(f) = post_T(f)（中间没有经占用的写入）。

这两次拍照必须卡在占用的边界上，否则会被别人的写入插队，所以 worker 要**等 Main 应答**再继续：

```text
首次占用 f ──► workspace-files{phase:'claim'} ──► Main 拍 pre ──► ack ──► 执行写工具
轮次结束   ──► workspace-files{phase:'release'} ─► Main 拍 post ─► ack ──► 释放占用
```

`turn-completed` / `turn-failed` 照常立即发出，不等 post 快照；只有占用晚一点释放，等这些文件的其他成员多等几十毫秒。

### 2.2 worker 侧（`src/agent/workspaceClaims.ts` + `supervisor.ts`）

- 占用条目由 `{ owner, root }` 扩为 `{ owner, root, turnId }`。`claimFiles` 只对**本轮新登记**的文件触发钩子 `onClaim(owner, turnId, files)` 并 `await` 后再执行写工具：
  - 同轮重复写同一文件不再上报；
  - 委派链祖先已占用的文件，子会话再写不上报（同属根轮次，见 2.4）；
  - 同会话下一轮写到上一轮「释放中」的文件，按 turnId 不同视为新占用并上报（Main 按事件顺序先处理上一轮 release，所以 pre 正好等于上一轮 post）。
- `release(owner)` 改为：先 `await onRelease(owner, turnId, files)`，再删除占用并 `wake()`。会话被回收的 `forget()` 不等应答（会话已无，Main 侧把未收尾的记录标为 incomplete）。
- `runExclusive` 在等到独占后、执行命令前 `await onExclusive('start')`，命令结束、解除独占前 `await onExclusive('end')`。
- 新增 `tryClaim(owner, cwd, files)`：不等待，被阻塞时返回阻塞者列表，供撤回使用（见 3.2）。
- 应答超时：claim / exclusive-start 5s，release / exclusive-end 10s。超时后照常继续，把未拿到 pre 的文件放进 release 事件的 `unacked`，Main 将其标为不可撤回。Main 不在线时不阻塞写入。
- 只上报工作区 `canonical(cwd)` 内的文件，路径转成相对 posix；工作区外的写入不上报（不在撤回范围内）。远程（ssh）会话不参与占用，同样不上报。
- 钩子由 supervisor 注入，实现沿用 `computer-request` / `computer-result` 的 requestId 往返模式（pending map + 超时）。

### 2.3 worker ↔ Main 协议（`src/shared/types/agent.ts`）

worker 协议不是 Electron IPC，不需要通道常量与 preload；但必须同时改类型联合、`parseAgentEvent` / `parseAgentCommand` 白名单（`hasExactKeys`）、Main 分发和 `agent.test.ts` 正反例。

```ts
// worker → Main（AgentWorkerEvent）
| { type: 'workspace-files'; identity: SessionIdentity | ChildSessionIdentity; seq: number;
    requestId: string;
    turnId: string;                 // 与 turn-completed 同源（managed.currentTurnId）
    phase: 'claim' | 'release' | 'exclusive-start' | 'exclusive-end';
    files: string[];                // 工作区内相对 posix 路径；exclusive-* 为空
    unacked?: string[] }            // 仅 release
| { type: 'workspace-claim-result'; seq: number; requestId: string; ok: boolean;
    blockers?: { label: string; file?: string }[] }

// Main → worker（AgentCommand）
| { type: 'workspace-files-ack'; identity: SessionIdentity | ChildSessionIdentity; requestId: string }
| { type: 'workspace-claim'; requestId: string; cwd: string; files: string[]; label: string }  // 撤回 try-claim，进程级，owner = `revert:<requestId>`
| { type: 'workspace-release'; requestId: string }
```

校验：`files` 每项非空、非绝对、不含 `..` 段、无 NUL；`phase` 为枚举；数量上限 1000（超出 worker 截断并整轮标 `files-truncated`）。Main 不信任 worker 给的路径去推导工作区：工作区由 Main 从会话记录推导，`files` 只作为其下相对路径，再做一次越界校验。

### 2.4 Main 侧归属（`BotSessionHost` + `turnSnapshots/attribution.ts`）

- 收到 `workspace-files` 后按会话 → 轮次映射：
  - 群成员会话：当前 `turnKey`，以 `(conversationId, worker turnId)` 建键，release 按 turnId 找回，不受 Main 已切到下一轮影响；
  - 委派子会话：沿 `ancestors()` 找到根会话，记入根会话所在轮（**委派链整条记一轮**，`members` 列出参与成员，`files` 不按子成员细分）；
  - 私聊 / 非群会话：立即 ack，只登记到 Main 级「工作区占用日志」（用于 2.5 的未归属判定），不拍快照。
- 每个群一个串行队列处理快照（共用 shadow index），处理完再 ack。claim 拍 pre、release 拍 post；pre == post 的文件从 changeset 去掉。
- 轮次结束 = 收到该轮 release 应答完成（或会话结束兜底）；只有此后才可撤回，未收尾的标 `incomplete`。

### 2.5 不经占用的写入

| 来源 | 归属方式 | 漏记？ |
| --- | --- | --- |
| edit / write / apply_patch（含 apply_patch 的删除、改名两端） | 占用上报，精确 | 不漏 |
| 全局命令（git 改树类、包管理 install/add/remove、`rm -r`） | exclusive-start / end 两次**整树**快照，diff 归到该轮。执行期间其他写工具被挡住，所以 diff 基本只属于本链 | 不漏；但 git 改树类命令（checkout/switch/reset/rebase/merge/pull/stash/restore/clean 等）同时改了 HEAD / index，只改回文件会造成仓库状态不一致，这些文件记为 `revertible:false, reason:'git-operation'` |
| 普通 bash（`sed -i`、重定向、脚本、格式化、代码生成） | 无法精确归属 | **会漏**。检测：每轮开始 / 结束各拍一次整树快照，`diff` 减去窗口内工作区占用日志里出现过的文件，剩下的记为该轮 `unattributed`；并发窗口重叠时会同时出现在多轮里。预览提示「本轮期间另有 N 个文件被改动、无法确定是谁改的，不会撤回」 |
| 后台命令（只在前台启动阶段独占） | 同普通 bash | 会漏，同上检测 |
| Code 会话、用户手改 | 不占用 | 同上检测；撤回时它们落在三方合并的 ours 一侧，会被保留 |

另两个已知偏差：

- T 先用 bash 改了 f、之后才用编辑工具占用 f，pre_T(f) 已含 bash 改动，撤回只回到那个状态；
- 别人在 T 占用 f 期间用 bash 改 f，会被算进 T。

不靠拦截 bash 去补齐归属（需要文件系统监控或沙箱，超出本期）。

## 3. 撤回

### 3.1 合并规则（与 v1 相同，输入改为按文件）

changeset_T = T 记录里可撤回的文件。对每个 f 三方合并：base = post_T(f)，ours = current(f)（撤回前现拍），theirs = pre_T(f)。实现上用只含 changeset 文件的三棵树走 `git merge-tree --write-tree --merge-base`（git ≥ 2.38）。

1. **后续未动**（current == post_T）：直接回到 pre_T。
2. **后续改了不重叠**：自动合并，保留后续改动。
3. **冲突**（同一 hunk；T 新建后又被改；T 删除后被重建；二进制被再改）：默认**整体拒绝**，不写半个文件、不落冲突标记；预览列出冲突文件和依赖轮次（索引里 changeset 含该文件且晚于 T 的轮次）；可「级联撤回」：从最新依赖轮次倒序到 T，在影子仓库里全部算完无冲突才写盘，原子执行。v1 不提供强制覆盖。

### 3.2 撤回时有成员正占用相关文件

**拒绝，不排队等待。** 理由：占用持有到对方本轮结束，可能几分钟；撤回是用户在界面上点的，挂起等待体验差，且等待期间 current 还会继续变，预览失效。

流程：

1. Main 发 `workspace-claim`（files = 本次 changeset，级联时取并集）。worker `tryClaim`：
   - 任一文件被非本次撤回的会话占用，或该工作区有全局命令正在执行 → 返回 `ok:false` 和阻塞者，撤回失败，界面提示「Bob 正在改 src/a.ts，等他这轮结束后再撤回」；
   - 否则以 `revert:<requestId>` 登记占用（无祖先，与所有成员互斥）。
2. 持有占用期间：拍 ours → 算计划 → 写盘。成员的写工具碰到这些文件会走现有等待逻辑（工具内等待、`Waiting: …` 提示）；全局命令也会等撤回结束。
3. 写盘前逐文件比对 current 是否仍等于计划时的 ours（防普通 bash 插队）；不一致则放弃，已写文件用撤回前快照恢复（仅限 changeset）。
4. 写完拍 post，记一条 `kind:'revert'`，然后 `workspace-release`。Main 侧 30s 兜底释放；worker 侧 `revert:*` 占用 60s 无释放也自动清掉，防 Main 异常时永久卡住成员。

其他规则沿用 v1：被撤回的轮次必须已收尾；同一轮不能重复撤回；撤回本身可再撤回；撤回成功写一条群时间线 system 条目，成员下一轮自然知道文件被回滚；语义依赖检测不了，只提示「T 之后还有 N 轮改过工作区」。

## 4. 快照存储与体积控制

每群一个影子仓库，git / 非 git 同一条路径：

```text
userData/bot-chats/<chatId>/snapshots.git      # bare，GIT_DIR
userData/bot-chats/<chatId>/snapshots.index    # GIT_INDEX_FILE，整树快照的 stat 缓存
userData/bot-chats/<chatId>/turn-snapshots.jsonl
```

- 按文件拍照：`git hash-object -w`（pre / post 文件不存在记 `null`）；整树快照：`GIT_WORK_TREE=<workspace> git add -A && git write-tree`。每轮用 `commit-tree` 把涉及的 blob / tree 挂到 `refs/turns/<turnKey>` 防 gc。
- 不碰用户仓库的 refs / index / HEAD / 对象库，不受 `pruneStaleCheckpoints` 影响；删群时 `chatStore.ts` 删整个群目录一并清掉。

排除与上限：

- 工作区 `.gitignore`（含嵌套）照常生效；`snapshots.git/info/exclude` 写入 `IGNORED_DIR_NAMES`（`node_modules`、`dist`、`.next` 等）；嵌套 `.git` 跳过。
- 被占用的文件若命中 ignore（例如成员直接改 `dist/x.js` 或 `node_modules/...`），**不入库**，记 `skipped:'ignored'`，不可撤回。用 `git check-ignore` 判定，与整树快照口径一致。
- 单文件 > 10 MiB（复用 `MAX_UNTRACKED_FILE_SIZE`）不入库，记 `skipped:'too-large'`。
- 整树快照沿用 `MAX_UNTRACKED_DIR_FILES`（200）大目录检测，超限目录不入库并记入该轮 `reason`。
- 每轮新增对象累计 > 64 MiB：后续文件不再入库，标 `skipped:'turn-cap'`，该轮部分可撤回。
- 每群 `snapshots.git` > 1 GiB：空闲时按最旧轮次删 ref + `git gc --prune=now`，直到降到 768 MiB；另保留策略为最近 100 轮或 14 天。

记录结构（每轮一条，撤回也是一条）：

```ts
{ v: 2, kind: 'turn' | 'revert', turnKey, chatId, memberId, conversationId,
  members: string[],                         // 委派链参与成员
  startedAt, endedAt?,
  files: { path, pre: sha | null, post: sha | null,
           source: 'claim' | 'exclusive',
           skipped?: 'ignored' | 'too-large' | 'turn-cap' | 'unacked' | 'git-operation' }[],
  unattributed: string[],                    // 2.5 检测到、不撤回
  revertOf?: string[], revertedBy?: string,
  status: 'open' | 'complete' | 'incomplete', reason?: string }
```

崩溃恢复：启动时 `status:'open'` 的记录改为 `incomplete`，不可撤回。

## 5. 所属层与必改文件

主逻辑在 **Main**（影子仓库、归属、撤回计划与执行）；**worker** 只做占用边界上的上报与 try-claim，因为占用状态只存在于 worker 进程内。renderer 只做入口与预览。

worker：

- `src/agent/workspaceClaims.ts`：占用条目带 turnId；`onClaim` / `onRelease` / `onExclusive` 钩子（可 await）；`release` 等应答后释放；`tryClaim` 与 `revert:*` 超时自清。
- `src/agent/supervisor.ts`：注入钩子（requestId pending map + 超时）；处理 `workspace-files-ack` / `workspace-claim` / `workspace-release` 命令。

协议：

- `src/shared/types/agent.ts`（+ `agent.test.ts`）：2.3 的事件与命令类型和解析校验。

Main：

- `src/main/services/agentHost.ts`：转发新事件给 bot runtime，提供发送新命令的出口（同 `computer-result`）。
- `src/main/ipc/bots.ts` `createRuntime`：接线。
- `src/main/services/bots/botSessionHost.ts`：处理 `workspace-files`、会话 → 轮次 / 根轮次映射、轮次开始 / 结束整树快照（不阻塞 pump）、工作区占用日志。
- `src/agent/checkpoint/core.ts`：仅抽出「工作区 → tree」快照函数，支持 `GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE`；现有导出行为不变。
- 新增 `src/main/services/bots/turnSnapshots/`：
  - `shadowRepo.ts`：init / hash-object / 整树快照 / merge-tree / 写回 / gc；
  - `attribution.ts`：纯函数，输入事件流与快照结果，输出每轮 files / unattributed（主要测试对象之一）；
  - `revertPlan.ts`：纯函数，输出 clean / conflict / cascade 计划；
  - `store.ts`：`turn-snapshots.jsonl`，append-only，带 `schemaVersion`。

renderer IPC（三件套）：

- `src/shared/types/ipc.ts` 通道常量：`BOT_TURN_SNAPSHOTS_LIST` / `_PREVIEW` / `_REVERT`；
- `src/main/ipc/bots.ts` handler：入参只收 `chatId`、`turnKey`（级联时 `turnKeys[]`），按 `unknown` 收窄；
- `src/preload/index.ts` typed 出口；
- `src/tooling/productCapabilityCoverage.fixture.ts` 同步登记（与其他 `BOT_*` 一样 `excluded`）。

其他：

- `src/shared/bots/` 类型：`TurnSnapshotRecord`、`RevertPreview`（含 `blockers`、`unattributed`）。
- `src/renderer/components/bots/BotChatView.tsx` + bots store：回合气泡「撤回本轮改动」入口、预览弹窗（文件 / 冲突 / 级联 / 占用阻塞 / 未归属提示）。

## 6. 明确不做

- 群聊的**对话** rewind（保持 `direct-only`），只撤文件；
- 现有单会话 `CheckpointManager`、`refs/enso-checkpoints`、私聊 rewind 不动；
- 委派链内按子成员细分归属（已定）；
- 普通 bash / 后台命令写入的精确归属与撤回（只检测提示）；不做文件系统监控或沙箱拦截；
- 撤回 git 历史操作（HEAD / refs / index），git 改树类命令涉及的文件只记录不撤回；
- 撤回排队等待占用释放（v1 一律拒绝）；
- 把 Code 会话纳入占用；
- 语义依赖分析、按 hunk 挑选、冲突标记手工解决、强制覆盖；
- 工作区外副作用（其他目录、数据库、网络、被 ignore 的安装 / 构建产物）；
- 远程（ssh）工作区；
- 跨群统一快照视图。

## 7. 测试点（Red-Green，先写失败测试）

git 相关用临时目录真跑 git，不依赖开发机配置。

`workspaceClaims.test`：

- 首次占用触发 `onClaim` 且写工具在其 resolve 后才执行；同轮同文件再写不重复触发；
- 委派子会话写祖先已占用的文件不触发；
- 同会话新一轮写上一轮「释放中」的文件：按新 turnId 触发；
- `release` 在 `onRelease` resolve 前不放行等待者；应答超时后释放，`unacked` 带上超时文件；
- `runExclusive` 前后各触发一次，且 start 应答前命令不执行；
- `tryClaim`：他人占用 / 全局命令执行中 → 立即返回阻塞者不等待；`revert:*` 占用期间成员写工具等待，释放后继续；超时自清；
- **并发两成员改不同文件**：A 写 a.ts、B 写 b.ts 并行，两次 `onClaim` 各带自己的 owner / turnId，互不等待；
- **并发两成员改同一文件**：B 的 `onClaim` 在 A 的 `onRelease` resolve 之后才触发。

`agent.test`：新事件 / 命令解析正反例（绝对路径、`..`、空串、未知 phase、多余键、超量 files）。

`attribution.test`（纯函数）：

- 不同文件并发：A 轮只含 a.ts、B 轮只含 b.ts，整树 diff 不串轮；
- 同一文件先后：A 轮 pre0→post1，B 轮 pre1→post2；
- 委派子会话的占用记入根轮次，`members` 含子成员；
- 全局命令窗口 diff 归该轮；git 改树类命令文件 `revertible:false`；
- 普通 bash 写入进 `unattributed`，被任一会话占用过的文件不进；
- `unacked`、ignored、超 10 MiB、超每轮上限分别标 skipped；乱序 / 未知 turnId / 已结束轮次的迟到事件丢弃。

`revertPlan.test`（纯函数，沿用 v1 并补充）：

- 后续未动 → clean 回到 pre；不同 hunk → 合并；同 hunk / 新建后被改 / 删除后重建 / 二进制再改 → conflict 并列依赖轮次；级联倒序正确、任一冲突整体拒绝；重复撤回拒绝；撤回 revert 恢复原样；
- **A、B 并发改不同文件，撤回 A 只还原 a.ts，b.ts 不变**；
- **A、B 先后改同一文件**：不同区域撤回 A 保留 B；同一区域冲突，级联 B→A 成功。

`shadowRepo.test`：非 git 目录可快照 / 撤回；git 目录前后用户仓库 `for-each-ref`、HEAD、`git status`、index 不变；`.gitignore` 与 `IGNORED_DIR_NAMES` 生效、嵌套 `.git` 跳过；写回前 current 与计划不符时放弃并恢复；超总量 gc 到阈值以下。

`store.test`：坏行跳过、`schemaVersion` v1→v2、`open` 启动改 `incomplete`、保留策略、删群目录消失。

`BotSessionHost`：`workspace-files` → 拍照 → ack 的顺序；私聊会话立即 ack 不拍照；未收尾轮不可撤回；撤回时 `workspace-claim` 失败 → 返回阻塞成员；撤回成功写 system 条目并 release。

IPC：非法入参、未知 `chatId` / `turnKey` 拒绝；renderer 无法传入路径。

真机（AGENTS.md：至少两家模型，如 Max claude-opus-5-5 + Grok grok-4.7-build-fast，同群同工作区并发）：

1. A 改 a.ts、B 同时改 b.ts → 撤回 A 只还原 a.ts；
2. A、B 先后改同一文件不同区域 / 同一区域 → 撤回与级联撤回；
3. B 正占用 a.ts 时撤回 A → 被拒并提示 B；
4. 成员用 `sed -i` 改文件 → 预览列为未归属，不被撤回；
5. `pnpm install` 后撤回 → `node_modules` 不入库，lockfile 可撤回。

## 8. 工作量

| 项 | 人日 |
| --- | --- |
| core 抽取 + 影子仓库 + 体积上限 / gc + 测试 | 1.5 |
| workspaceClaims 钩子 / turnId / tryClaim + supervisor 接线 + 测试 | 1 |
| worker 协议事件 / 命令 + 解析测试 | 0.5 |
| Main 归属（映射、根轮次、整树检测、attribution 纯函数）+ 测试 | 1 |
| revertPlan 纯函数 + 测试 | 1 |
| store + 保留 / 崩溃恢复 | 0.5 |
| 撤回执行（try-claim、CAS 写回、兜底释放） | 0.5 |
| renderer IPC 三件套 / shared 类型 | 0.5 |
| renderer 入口 + 预览弹窗 | 1 |
| 真机（两家模型、并发场景）+ 修复 | 0.5 |
| **合计** | **约 8 人日** |

风险：

- 占用边界上的应答往返进入写工具和轮次收尾的关键路径；Main 卡顿会拖慢写入（有超时兜底，代价是该文件不可撤回）。需要压测大文件和大仓库整树快照耗时。
- 事件顺序依赖 worker → Main 单通道有序；Main 处理按群串行，跨群共享同一工作区时各群各拍各的，互不阻塞但对象重复存储。
- 普通 bash 写入只能提示不能撤回，需要在预览里讲清楚，避免用户以为「已全部撤回」。
