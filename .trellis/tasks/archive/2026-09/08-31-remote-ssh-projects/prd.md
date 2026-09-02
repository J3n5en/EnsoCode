# Remote SSH Projects with Local Chat History

## Goal

「添加项目」时可以添加**远程项目**(SSH):项目指向远端机器上的目录,其下的会话是远程会话——聊天历史(pi session jsonl)保留在本地 `userData/agent/sessions/`,agent 的全部工具调用通过 SSH 在远端执行。用户价值:代码/环境在远端服务器,模型密钥、账单、聊天历史留在本机,像操作本地项目一样操作远程项目。

## Background (codebase facts)

- 项目权威:`src/main/services/sourceAuthorityRegistry.ts`,JSON 存 `userData/agent/source-registry.json`;`createProject` 本地校验 `realpathSync + statSync().isDirectory()`(:87-90)。
- 类型:`ProjectAuthority { projectId; canonicalPath; state; version }`(`src/shared/types/agent.ts:172`),parser `parseProjectAuthority` 用 `hasExactKeys` 严格校验(:818)。
- 添加项目 UI:`src/renderer/components/chat/Sidebar.tsx` AddProjectDialog(本地目录选择器);store `src/renderer/stores/settings/index.ts:480`;IPC `src/main/ipc/projects.ts:22-30`。
- Agent 执行:Electron `utilityProcess` worker 直接 import pi SDK(`src/main/services/agentHost.ts:88`,`src/agent/supervisor.ts:4-16`);**工具全部由 `supervisor.ts:789-816` 的工厂创建**,cwd 是工厂参数。
- 聊天历史已天然本地:`SessionManager.create(cwd, sessionDir)` jsonl 与 cwd 解耦(supervisor.ts:1050-1051)。
- spawn 链:renderer → `AGENT_SPAWN`(`src/main/ipc/agent.ts:443-465`;:131-133 校验 cwd 必须等于 project.canonicalPath 或登记 worktree)→ agentHost `spawn-parent` → supervisor.spawn。
- checkpoint:`src/agent/checkpoint/core.ts` 几乎纯 git 命令(`spawn('git', args, {cwd})`),数据存 repo 自身 refs;仅 `statSync`(:167)与 `mkdtemp` 临时 GIT_INDEX_FILE(:262)碰本地 FS。
- gate 命令本地 `execFile`(supervisor.ts:1942);resourceLoader 扫 cwd AGENTS.md/skills(supervisor.ts:170-188);worktree `src/main/ipc/worktree.ts`。
- 现无任何 SSH/remote 执行代码。

### 参考项目侦察

- **deepchat**:无 SSH 能力("remote" = IM 机器人遥控本机),不可借鉴。
- **orca**(stablyai):成熟 SSH 体系——ssh2 库 + 系统 OpenSSH 兜底 + 远端 relay 守护进程(PTY/git/fs 走 relay RPC,断线任务存活)。作为档位 2 的未来演进参照,代码在 `~/project/orca`。

## Key Decisions

- **D1 执行模型 = 档位 1**:纯 SSH exec + 连接复用,不部署远端 relay。relay(orca 式)留作后续演进。
- **D2 传输**:系统 `ssh` 子进程 + ControlMaster 持久连接(`-o ControlMaster=auto -o ControlPath=... -o ControlPersist=...`)。天然继承 `~/.ssh/config`(密钥/跳板机/别名),app 零凭据管理。不用 ssh2 库。
- **D3 checkpoint 远程化纳入 MVP**:`git()` helper 注入 executor(本地 spawn / 远端 ssh);`statSync` 合批为一次远端 stat;临时 index 用远端 `mktemp -d`。非 git 仓库沿用既有静默禁用降级。
- **D4 UI**:AddProjectDialog 加「远程」tab,输入 `user@host`(或 ssh config 别名)+ 远端绝对路径;确认时 `ssh host test -d path` 校验。不做远端目录浏览。
- **D5 远端 AGENTS.md**:MVP 远程读取 `<cwd>/AGENTS.md` 单文件(一条 ssh cat);skills 目录扫描不做。

## Requirements

1. **R1 数据模型**:`ProjectAuthority` 增加 `kind?: 'local' | 'ssh'`(缺省 local,兼容存量 JSON)与 `sshHost?: string`(ssh 目标,host 别名或 user@host);`canonicalPath` 对 ssh 项目存远端绝对路径。parser、registry 持久化、projection 同步更新。
2. **R2 添加/校验**:`SOURCE_PROJECT_CREATE` 支持 ssh 项目;main 侧用 `ssh <host> test -d <path>` 异步校验替代 realpathSync;去重按 (kind, sshHost, canonicalPath)。
3. **R3 UI**:AddProjectDialog 「远程」tab(host + 路径两输入框),校验失败给出可读错误;远程项目在侧栏可视区分(图标/标签);远程项目隐藏 worktree 入口。
4. **R4 spawn 透传**:`AgentSpawnRequest` / `spawn-parent` 命令携带 `remote?: { host: string }`;`main/ipc/agent.ts:131-133` cwd 授权检查按 kind 分流(ssh 项目校验 cwd === canonicalPath,不查 worktree)。
5. **R5 SSH executor(worker 内)**:模块提供 `exec(argv/script, { stdin?, timeout?, signal? }) → { stdout, stderr, code }`,底层 spawn 系统 ssh,ControlMaster socket 放 `userData/agent/ssh/`;连接失败/超时给出可读错误。
6. **R6 远程工具**:read/grep/find/ls/bash/edit/write 的 SSH 版 `ToolDefinition`,与本地版参数 schema 一致;supervisor 工具工厂按 remote 分流(子代理/coworker 同样生效)。edit 采用「远端读 → 本地做替换 → 远端写回」;write/read 经 stdin/stdout 传内容,支持二进制安全(base64 或 stdin 直传)。
7. **R7 gate**:远程会话的 gate 命令走 SSH 执行。
8. **R8 checkpoint**:按 D3 远程化;每命令一跳 MVP 可接受,高 RTT 优化(命令序列打包成单条远端脚本)作为后续项记录。
9. **R9 后台任务**:远程 bash 的 background 允许,生命周期 = app/连接存活期;文档与 UI 提示如实。
10. **R10 资源加载**:远程会话 resourceLoader 跳过 cwd 扫描,仅加载全局资源 + 按 D5 远程读 AGENTS.md 单文件。
11. **R11 历史验证**:远程会话的 session jsonl 仍落本地 sessions 目录(验证,无预期代码改动)。

## Acceptance Criteria

- AC1: 在 AddProjectDialog 远程 tab 输入有效 host+路径可创建项目;无效路径/不可达 host 得到明确错误,不创建。
- AC2: 远程项目下新建会话,发消息后 agent 的 read/ls/grep/find/bash/edit/write 均作用于远端(远端文件被实际读/改),本地对应路径不受影响。
- AC3: 该会话的聊天历史 jsonl 出现在本地 `userData/agent/sessions/`,重启 app 后可 resume。
- AC4: 远程 git 项目中,写盘工具触发的 checkpoint 出现在远端 repo 的 `refs/enso-checkpoints/*`,回退还原能恢复远端工作树;非 git 远端目录静默禁用不报错。
- AC5: 远程项目 UI 不出现 worktree 入口;本地项目一切行为不变(回归)。
- AC6: 远端 `<cwd>/AGENTS.md` 存在时其内容进入 system context;不存在时静默跳过。
- AC7: 存量 source-registry.json(无 kind 字段)加载后行为不变。
- AC8: `pnpm typecheck && pnpm test` 通过,新增纯逻辑(ssh argv 构建、远程工具参数映射、parser 扩展、checkpoint executor 抽象)有先行测试。

## Out of Scope

- 远端 relay 守护进程 / 断线任务存活(档位 2,未来演进,参照 orca)。
- 密码登录、known_hosts/密钥管理 UI(依赖系统 ssh config)。
- 远端目录浏览器 UI。
- worktree、skills 目录的远程支持。
- Windows 平台的 ControlMaster 降级处理(主力 macOS;Windows 每调用独立 ssh 可用但慢,不专门优化)。
- checkpoint 命令打包单跳优化(记录为后续项)。

## Risks / Notes

- 延迟模型:ControlMaster 省建连不省 RTT,每工具调用 ≥1-2 RTT;跨国高 RTT 场景 checkpoint(串行 6-10 命令)会明显变慢,已列后续优化。
- 远端环境假设:bash、git(checkpoint 用)、GNU 常用工具存在;grep/find 行为与本地 ripgrep/glob 语义差异需在工具实现里对齐参数语义。
- 二进制/编码:read/write 过 ssh 管道需保证字节安全,避免 shell 转义破坏内容(用 stdin + base64 或 `cat > file` 直传)。
