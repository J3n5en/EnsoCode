# 交叉排查：打开大历史对话卡在「加载中」

参与：timeline-ui (Opus)、sessions-store (GPT-5.6)、main-ipc (Grok)、journal-proj (Kimi)、virtual-md (GLM)。

## 用户看到的「加载中」

`MessageTimeline.tsx`：`items.length === 0 && busy` → spinner +「Preparing session…」
`busy = running || spawning`（`ChatView.tsx`）

重启后点有 `sessionFile` 的根会话：`ChatView` 自动 `resumeConversation` → `spawning:true`。
spawn IPC **立刻 ack**，**不清 spawning**；等该会话**第一条 worker 事件**。

## 共识调用链

```
selectConversation（只改 activeId + authority）
  → ChatView 自动 resumeConversation
  → AGENT_SPAWN + resumeFile（Main 入队即 ok）
  → worker: runtime/skills/MCP + SessionManager.open(整份 jsonl，同步 parse)
  → transcript + projectMessage 全量投影
  → 一条 snapshot（全量 messages）
  → Main parse + sendToAllWindows
  → renderer 一次 set 灌入 messages，清 spawning
```

persist **不存 messages**（partialize 置空）。打开必须走 resume/snapshot。

## 按层排序的根因

### P0 等待：worker spawn + 整卷 jsonl 回放（「加载中」时长）

- 证据：`supervisor.ts` resume 才 emit snapshot；`index.ts` spawn ack 后故意留 spawning。
- 成本：整文件 `loadEntriesFromFile` + 全量投影 + skill/MCP 初始化。首事件前 UI 只能转圈。
- 证伪：打点 `spawn ack` → `[spawn] total` → renderer 收到 snapshot。若这段 ≈ 转圈时长，成立。

### P0 卡顿：一条巨型 snapshot 过 IPC + 主线程一次灌入

- 无分页。桌面不像手机 `narrowSnapshot` 截尾窗。
- 图的 base64 不截断；tool args `structuredCloneSafe`。
- worker→main→全窗口 两次结构化克隆；Main `parseAgentWorkerEvent` 同步扫全部 messages。
- renderer：一次 `set` + `buildTimeline` + `foldTimeline`（O(N)，虚拟化挡不住）。
- 证伪：snapshot 字节 / clone 耗时；`buildTimeline` `performance.now`；Performance 长帧落点。

### P1 已结束 coworker TAB：Main 同步 `readChildHistory`

- `EnsoSafeJournal.restore`：`readFileSync` + 逐行 `JSON.parse`，在 `ipcMain.handle` 里同步。
- 不置 `spawning`，UI 可能空白而不是 spinner；Main 会卡。

### P2 渲染（次要，spinner 消失后）

- 桌面 Virtuoso 真窗口化；历史 diff 默认折叠（曾因成排 FileDiff 白屏数秒，已修）。
- 视口内 Markdown 同步解析；shiki 首次初始化可能几百 ms。
- 冷缓存驱逐后 `started && !spawning && messages=[]` 会闪「Ask the agent…」而不是 loading。

### 已排除

- persist 写出整卷 messages
- 打开触发 compact / rebuild_full_history
- 虚拟化失效导致挂载全部行（桌面）
- `selectConversation` 在 Main 读 jsonl（根会话）

## 修复方向（未实施）

1. resume 先发「文件头/尾窗」快照，再后台补全；或 UI 用 sessionFile 元数据先结束 spinner。
2. spawn 与 journal 投影拆开：先 open+snapshot，技能/MCP 后置（缩短 spawning）。
3. 桌面 snapshot 尾窗（对齐 pairPolicy），上滑再要更早页。
4. `readChildHistory` 挪到 worker / 异步流。
5. 冷缓存空态改走 Preparing session。
