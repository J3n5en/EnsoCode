# Design — Remote SSH Projects

## 架构总览

```
renderer (AddProjectDialog 远程 tab)
   │  SOURCE_PROJECT_CREATE { kind:'ssh', sshHost, path }
   ▼
main: ipc/projects.ts ──ssh test -d──▶ 远端校验
   │  sourceAuthorityRegistry (kind/sshHost 持久化)
   │
   │  AGENT_SPAWN { cwd, remote:{host} }   (ipc/agent.ts cwd 授权按 kind 分流)
   ▼
main: agentHost ── spawn-parent{remote} ──▶ utilityProcess worker
                                              │
                                    supervisor.spawn(identity, cwd, remote)
                                              │
                            工具工厂分流 (supervisor.ts:789-816)
                             ├─ local: 现状不变
                             └─ ssh:  remoteTools(sshExec, cwd)
                                        │
                              SshExecutor (系统 ssh + ControlMaster)
                                        ▼
                                     远端主机
聊天历史: SessionManager → 本地 userData/agent/sessions/ (不变)
```

## 模块边界

### 1. shared 类型 (`src/shared/types/agent.ts`)

```ts
interface ProjectAuthority {
  projectId: string;
  canonicalPath: string;      // ssh 项目 = 远端绝对路径
  kind?: 'local' | 'ssh';     // 缺省 local(存量兼容)
  sshHost?: string;           // ssh config 别名或 user@host;kind==='ssh' 必有
  state: 'active' | 'removed';
  version: number;
}
```

- `parseProjectAuthority`:`hasExactKeys` → `hasOnlyKeys`(允许可选字段);kind==='ssh' 时要求 sshHost 非空;kind 非法值拒绝。
- `spawn-parent` 命令负载增加 `remote?: AgentRemoteConfig`。**实施微调**：`AgentSpawnRequest`（renderer → main）不携 remote；main 在 spawn handler 里从项目权威 `project.kind/sshHost` 派生并注入 spawn-parent，消除 renderer 伪造面。
- IPC `SOURCE_PROJECT_CREATE` 请求体:`{ path } → { path, kind?, sshHost? }`。

### 2. main 进程

- `sourceAuthorityRegistry.createProject`:按 kind 分流。
  - local:现状(realpathSync + isDirectory)。
  - ssh:不做本地 FS 校验(远端校验在 IPC handler 完成,registry 只做规范化:路径必须以 `/` 开头、去尾斜杠);去重键 = kind + sshHost + canonicalPath。
  - 校验放 handler 层的原因:registry 当前是同步 API,远端校验是异步,不动 registry 的同步契约。
- `ipc/projects.ts` SOURCE_PROJECT_CREATE handler:kind==='ssh' 时先 `sshProbeDirectory(host, path)`(main 侧一个小 util,`execFile('ssh', [...ctlArgs, host, 'test', '-d', '--', path])`,超时 15s),失败返回结构化错误(host 不可达 / 路径不存在 / 非目录)。
- `ipc/agent.ts:131-133` cwd 授权:project.kind==='ssh' → 仅接受 cwd === canonicalPath(不查 worktree 注册表)。
- `ipc/worktree.ts`:ssh 项目的 worktree 操作直接拒绝(防御;UI 已隐藏)。
- agentHost `spawnSession`:透传 remote。

### 3. worker (`src/agent/`)

新增 `src/agent/ssh/`:

- **`executor.ts` — SshExecutor**(核心,可单测的部分拆纯函数):
  ```ts
  interface SshExecutor {
    exec(command: string[], opts?: { stdin?: string | Buffer; timeoutMs?: number; signal?: AbortSignal; cwd?: string })
      : Promise<{ stdout: string; stderr: string; code: number }>;
    execRaw(...): Promise<{ stdout: Buffer; ... }>;  // 二进制安全(read 用)
    dispose(): void;  // 关闭 ControlMaster
  }
  createSshExecutor(host: string, controlDir: string): SshExecutor
  ```
  - 底层 `spawn('ssh', buildSshArgs(host, ...))`;ControlMaster 参数:`-o ControlMaster=auto -o ControlPath=<controlDir>/%C -o ControlPersist=600 -o BatchMode=yes -o ConnectTimeout=10`。controlDir = `ENSO_AGENT_DATA_DIR/ssh/`。
  - `cwd` 语义:命令包成 `cd <cwd> && <cmd>`(argv 模式下经 `bash -lc` 包装;所有用户数据经 stdin 或单引号 shell-quote,纯函数 `shellQuote()` 单测)。
  - BatchMode=yes:密码交互直接失败并给出可读错误(「请配置密钥登录」),不挂死。

- **`remoteTools.ts` — 7 件套 ToolDefinition**,参数 schema 与本地版完全一致(从 pi SDK 类型对齐):
  | 工具 | 远端实现 |
  |---|---|
  | read | `dd`/`sed -n` 取行窗口;二进制经 execRaw+base64 |
  | ls | `ls -pa` + 排序,格式对齐本地输出 |
  | grep | 优先探测远端 `rg`,无则 `grep -rn` 参数映射;glob 过滤映射 `--include` |
  | find | `find -path/-name` glob 转换 |
  | bash | `bash -lc <script>`,cwd 前缀;`withBackground`/approval 包装照旧套在外面 |
  | write | 内容走 stdin:`mkdir -p $(dirname) && cat > file` |
  | edit | read 拉取 → 复用本地 `editTool` 的替换纯逻辑 → write 写回;写回前校验远端文件 mtime/hash 未变(防并发覆盖) |
  - 远端能力探测(rg 有无等)首次执行时探测并缓存在 executor 实例上。

- **supervisor 分流**:`spawn(identity, cwd, ..., remote?)` 持有 executor(每会话一个,ControlPath 按 host 哈希共享,实际连接跨会话复用);`readOnlyTools()` / `buildBaseTools()` 按 remote 选本地/远程工厂;gate `runGateCommand` 分流走 executor;resourceLoader:remote 时跳过 cwd 扫描,追加 `executor.exec(['cat', 'AGENTS.md'])`(容错缺失)。

- **checkpoint 远程化**(`src/agent/checkpoint/`):
  - `core.ts` 的 `git(cmd, cwd)` 改为 `git(cmd, cwd, { runner })`,`runner: (argv, opts) => Promise<Result>`;默认 runner = 现有本地 spawn(存量行为零变化)。
  - `statSync` 批检:改为一次 `runner` 调用远端 `stat --printf '%F %s\n'` 批量(或本地版保持 statSync,抽 `statBatch(paths)` 接口两实现)。
  - 临时 index:接口 `withTempIndex(fn)`——本地 mkdtemp / 远端 `mktemp -d` + 结束 `rm -rf`;GIT_INDEX_FILE 经 `env` 前缀传给远端 git。
  - `CheckpointManager` 构造注入 runner;失败降级逻辑(3 次禁用)不变。

### 4. renderer

- `AddProjectDialog`(Sidebar.tsx):Tabs「本地 / 远程」;远程 tab = host 输入 + 路径输入 + 提示文案(「使用 ~/.ssh/config 中的主机别名或 user@host,需密钥登录」);提交后 pending 态,错误内联展示。
- settings store `addProject`:透传 kind/sshHost。
- 侧栏项目条目:ssh 项目加图标(如 `Server`/`Globe` lucide)+ tooltip 显示 host;隐藏 worktree 相关菜单。
- sessions store spawn：cwd 逻辑不变（remote 项目无 worktree，自然取 project.path）；remote 由 main 派生，renderer 不传。

## 数据流契约

- 远程判定的唯一真源:`ProjectAuthority.kind`。renderer/main/worker 均由其派生,不各自存副本。
- worker 不读 registry;remote 信息只经 spawn 负载进入(与 cwd 同路)。
- 会话 resume(`SessionManager.open`)同样携带 remote——`AGENT_SPAWN` 的 resume 分支同 spawn 分支一致处理。

## 兼容与迁移

- 存量 registry JSON 无 kind:parser 视为 local,行为不变;写回时 local 项目不写 kind 字段(或写 'local',二选一,实现时定,倾向不写保持文件稳定)。
- `ensoAiProjects.ts` 对 remote 条目的跳过维持现状(其数据源与本特性无关)。

## 权衡记录

- 校验放 IPC handler 而非 registry:保住 registry 同步契约,代价是「校验与登记」非原子——可接受,竞态仅导致登记了一个此刻不可达的项目,spawn 时会再次自然失败。
- edit 走「拉取-本地替换-写回」而非远端 sed:复用既有 editTool 纯逻辑与语义(lenient 匹配),远端只需 cat/write 两跳;mtime 校验挡并发。
- ControlMaster socket 由 worker 持有、按 host 复用:多会话同 host 只有一条真连接;worker 退出 ControlPersist=600 让连接自然过期。

## 回滚

特性面全部在 kind==='ssh' 分支后;local 路径不动。出问题时 UI 隐藏远程 tab 即可停用,数据模型可保留。
