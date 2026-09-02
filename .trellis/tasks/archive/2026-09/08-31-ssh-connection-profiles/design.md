# Design: SSH 连接档案

## Boundaries

- **main** 独占 vault + 探测 + 把 `remote` 注入 spawn。渲染层只 CRUD 元数据、触发 test。
- **shared** 放连接类型、目标串解析、`buildSshExecArgs` 的 auth/port 开关。
- **worker** `SshExecutor` 按 `remote.auth` 决定 BatchMode vs ASKPASS；口令只活在该进程内存。
- 不改远端工具 Operations 语义；只改怎么拼 `ssh`。

## Data

公开（可进 IPC / 设置 UI）：

```ts
type SshAuth = 'key' | 'password';
interface SshConnection {
  id: string; // uuid
  name: string;
  host: string;
  user?: string;
  port?: number; // 缺省 22，不写 argv
  auth: SshAuth;
  hasPassword: boolean; // 仅 list 投影
}
```

目标串：`user` 有则 `user@host`，否则 `host`（别名）。`resolveSshTarget(conn)` 纯函数。

项目权威：

- ssh：`sshConnectionId` 必填；`sshHost` = 现算目标串（projection 给徽标）。
- 创建请求：`{ kind:'ssh', sshConnectionId, path }`，不再收自由 `sshHost`。
- 去重：`(kind, sshConnectionId, canonicalPath)`。

Vault 文件（`userData/ssh-connections.bin`）：

```ts
{ connections: Array<Omit<SshConnection,'hasPassword'> & { password?: string }> }
```

整包 `safeStorage.encryptString`。密码模式且加密不可用 → upsert 拒绝。

`AgentRemoteConfig`：

```ts
{ host: string; port?: number; auth: SshAuth; password?: string }
```

`password` 仅 password 认证、仅 spawn 内存；parser 允许该可选字段。禁止写入 session jsonl。

## Auth 执行

`buildSshExecArgs(host, cmd, { port, auth, controlPath, ... })`：

- `auth==='key'`（默认）：`BatchMode=yes`（现状）。
- `auth==='password'`：不加 BatchMode；加 `PreferredAuthentications=password,keyboard-interactive`、`NumberOfPasswordPrompts=1`、`IdentitiesOnly=yes`（减少先试钥匙再卡死）。
- `port` 有且 ≠22：`-p ${port}`。

ASKPASS（仅 worker/main 探测）：

1. 写 0700 小 helper（`userData/agent/ssh/askpass.sh`）：`printf %s "$ENSO_SSH_ASKPASS_PASSWORD"`。
2. 子进程 env：`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`DISPLAY=:`、`ENSO_SSH_ASKPASS_PASSWORD`、`SSH_AUTH_SOCK=`（避免 agent 抢答）。
3. env 会出现在该 ssh 子进程环境，不出现在 argv。不写进日志。

ControlMaster：同一 `resolveSshControlPath`；密码与免密都复用。换密码后旧 master 可能仍握旧会话——upsert 密码时 `ssh -O exit` 对应 ControlPath（尽力，失败不挡保存）。

## IPC

`sshConnections:list | upsert | delete | test`

- upsert：校验 name/host/auth；password 模式必须带非空密码或已有 vault 密码（改名不强制重输）。
- delete：`sourceAuthority` 有 active ssh 项目引用则 `{ accepted:false, error }`。
- test：解析档案 → `ssh … true`，超时/认证失败映射现有 probe 文案风格。

## UI

- `SettingsCategory` 加 `ssh`，页：`SshSettings.tsx`（对标 Providers 列表密度）。
- 表单：名称、Host、用户（可选）、端口（可选）、认证单选、密码框（password 时）。
- `AddProjectDialog` SSH tab：连接 Select + 路径；无连接 CTA「去设置」。

## Compatibility

刻意不兼容无 `sshConnectionId` 的 ssh 项目：parser 改为 ssh 必须有 id。开发期 registry 里若已有手填项目，加载失败或视为非法——用户确认尚未使用。

## Rollback

关设置分类 + 恢复自由 host 即可回退；vault 文件可删。密码连接在回退后会失效（BatchMode）。
