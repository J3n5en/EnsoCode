# Implementation Plan — Remote SSH Projects

按依赖序分 6 步,每步独立可提交、全绿再进下一步。TDD:标 ★ 的先写失败测试。

## Step 1: 数据模型 + parser(★)

- `src/shared/types/agent.ts`:`ProjectAuthority` 加 `kind?/sshHost?`;`parseProjectAuthority` 改 hasOnlyKeys + kind/sshHost 约束。
- ★ 测试:存量对象(无 kind)通过;kind:'ssh' 无 sshHost 拒绝;非法 kind 拒绝;合法 ssh 对象通过。
- `AgentSpawnRequest`/spawn-parent/`SOURCE_PROJECT_CREATE` 负载类型扩展(仅类型,行为下一步)。
- 验证:`pnpm typecheck && pnpm test`

## Step 2: registry + main IPC(★)

- `sourceAuthorityRegistry.createProject` 按 kind 分流(ssh:路径规范化纯函数 ★ + 去重键含 sshHost;跳过本地 FS 校验)。
- main 新增 `sshProbeDirectory(host, path)` util(execFile ssh test -d,结构化错误)。
- `ipc/projects.ts` handler:ssh 项目先 probe 再登记。
- `ipc/agent.ts` cwd 授权分流;`ipc/worktree.ts` 拒绝 ssh 项目。
- ★ 测试:registry 分流/去重/存量加载;路径规范化;(probe 本身依赖真 ssh,不单测,逻辑拆纯函数测参数构建)。

## Step 3: SshExecutor(★ 核心纯逻辑)

- `src/agent/ssh/executor.ts`:`buildSshArgs`/`shellQuote`/`wrapCommand(cwd, argv)` 为纯函数。
- ★ 测试:ControlMaster 参数、quote 边界(单引号/换行/UTF-8/空参)、cwd 包装、timeout/signal 语义(用 fake spawn)。
- executor 实体:spawn 管理、stdin 写入、Buffer 模式、dispose。

## Step 4: 远程工具 7 件套 + supervisor 分流(★)

- `src/agent/ssh/remoteTools.ts`:read/ls/grep/find/bash/write/edit。
- ★ 测试:每个工具「参数 → 远端命令 argv/stdin」映射(注入 fake executor 断言调用);edit 复用 editTool 替换逻辑 + mtime 冲突拒绝;read 行窗口/二进制。
- `supervisor.ts`:spawn 链接收 remote;工具工厂/gate/resourceLoader(AGENTS.md 单文件)分流;`agentHost.ts` 透传。
- 验证:本地项目全量回归(既有测试绿)。

## Step 5: checkpoint 远程化(★)

- `core.ts`:git() 注入 runner;statBatch/withTempIndex 双实现;`manager.ts` 注入。
- ★ 测试:既有 checkpoint.test.ts 保持绿(默认 runner);fake runner 断言远端命令序列(mktemp/env GIT_INDEX_FILE/stat 合批)。

## Step 6: renderer UI

- AddProjectDialog 远程 tab;settings store 透传;侧栏 ssh 图标 + 隐藏 worktree 菜单;sessions store spawn 带 remote。
- 手测走查(UI 不强制单测)。

## 端到端验证(真机)

1. 对一台可 ssh 免密的主机添加远程项目(AC1,含错误路径/坏 host 用例)。
2. 新会话让 agent `ls`、读文件、改文件、跑命令 → 远端生效(AC2)。
3. 本地 sessions 目录出现 jsonl,重启 resume(AC3)。
4. 远端 git repo:写盘后 `git for-each-ref refs/enso-checkpoints` 有快照,回退可还原(AC4)。
5. 远程项目无 worktree 入口;本地项目回归(AC5)。
6. 远端放 AGENTS.md,验证进 context(AC6)。
7. 用旧 registry JSON 启动(AC7)。

## 验证命令

```bash
pnpm typecheck && pnpm test && pnpm exec biome check src
```

## 风险文件 / 回滚点

- `supervisor.ts`(大文件,分流改动收敛在工具工厂与 spawn 入参)——每步小提交,坏了整步 revert。
- `parseProjectAuthority` hasExactKeys→hasOnlyKeys 是兼容面,Step 1 测试兜底。
- checkpoint core.ts 重构量最大,Step 5 独立提交,依赖 Step 3 的 executor 接口但不依赖 Step 4。

## 后续项(不在本任务)

- checkpoint 命令序列打包单跳(高 RTT 优化)。
- 档位 2:远端 relay(参照 ~/project/orca 的 src/relay)。
- skills 目录远程加载、远端目录浏览 UI。
