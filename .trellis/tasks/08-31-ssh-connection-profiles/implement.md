# Implement: SSH 连接档案

基线：`feat/remote-ssh-projects`（或该 PR 合入后的 `dev`）。TDD；测试中文名。

## Steps

1. **shared 纯函数 / 类型**
   - `SshConnection`、`resolveSshTarget`、`parseSshConnection`（无密码）。
   - `ProjectAuthority` / `CreateProjectAuthorityRequest`：ssh 必 `sshConnectionId`；去掉「只收 sshHost」路径。
   - `AgentRemoteConfig` 扩 `port?` / `auth` / `password?`。
   - `buildSshExecArgs`：`auth`/`port`；password 不加 BatchMode。
   - 测试：目标串、parser 拒绝无 id、argv 有无 BatchMode / `-p`。

2. **vault + IPC（main）**
   - `src/main/services/sshConnectionStore.ts`：仿 `pairStore`（加密整包、原子 rename、`isSecureStorageAvailable`）。
   - IPC：list/upsert/delete/test。delete 查 registry。
   - `sshProbe`：吃完整连接（host/port/auth/password），`true` 与 `test -d` 共用。
   - 测试：加密不可用拒密码；删除引用保护；probe argv。

3. **执行面**
   - `SshExecutor` 按 `remote.auth` 设 env + 关 BatchMode。
   - `remoteConfigFor`：用 `sshConnectionId` 查档案，填 host/port/auth/password。
   - 改密码后尝试 `ssh -O exit`。
   - 测试：executor 构造 env/argv（mock spawn）。

4. **设置 UI**
   - `SshSettings` + category + i18n。
   - 测连接按钮调 `test`，成功/失败 toast。

5. **AddProjectDialog + store**
   - 下拉连接；`createProject({ sshConnectionId, path })`。
   - 侧栏徽标用 projection 的 `sshHost`（现算）。
   - 无连接引导。

6. **验收**
   - `pnpm typecheck && pnpm test` + 改动文件 `biome check`。
   - 真机：设置里加免密测 `$SSH_E2E_HOST`；再加一条密码（若该机允许）；建项目选档案。
   - `SSH_E2E_HOST` 用例改为走档案或保持 host 字符串仅在 executor 单测。

## Validation

```
pnpm typecheck && pnpm test && pnpm exec biome check src/shared/ssh.ts src/shared/types/agent.ts src/main/services/sshConnectionStore.ts src/main/services/sshProbe.ts src/agent/ssh/executor.ts
```

## Risks

- ASKPASS 在无 DISPLAY 的 Electron 子进程：必须 `SSH_ASKPASS_REQUIRE=force` + 伪 `DISPLAY`。
- `ENSO_SSH_ASKPASS_PASSWORD` 在 ssh 进程 env：勿打日志、勿进 jsonl。
- ControlMaster 换密后仍复用旧通道：upsert 时 exit。
- parser 改严格后，本机若残留手填 ssh 项目会加载失败——先清 `source-registry` 或接受开发数据丢弃。

## Do not start until

用户明确批准本规划摘要。批准前不跑 `task.py start`、不改产品代码。
