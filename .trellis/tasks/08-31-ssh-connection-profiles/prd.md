# SSH 连接配置：密码/免密与测试

父任务：`08-31-remote-ssh-projects`。本任务把「主机从哪来、怎么认证」收成设置里的连接档案。尚未对外使用，**不兼容**手填 `sshHost` 的旧远程项目。

## Goal

用户在设置里添加 SSH 连接（免密或密码，可测试）。添加远程项目时从这些连接里挑，再填远端路径。密码进系统钥匙串，从不进普通 JSON。

## Background

- 现网探测/执行：系统 `ssh` + `BatchMode=yes`（`src/shared/ssh.ts`），密码登不进去。
- 添加项目：`AddProjectDialog` SSH tab 自由输入 host。
- 设置无 SSH 分类（`SettingsContent` / `SettingsCategory`）。
- 凭据先例：`pairStore` + `safeStorage`；钥匙串不可用禁止明文。
- 项目权威：`kind/sshHost`；spawn `remote: { host }` 由 main 派生。
- 仍是档位 1：不引入 ssh2、不部署 relay。密码走 `SSH_ASKPASS`，不进 argv。

## Key Decisions

- **D1 密码 = safeStorage**：只进钥匙串。`isEncryptionAvailable()===false` 拒绝保存密码连接。删连接即删口令。渲染层只见 `hasPassword`，不见明文。
- **D2 免密不指定私钥**：不提供 `-i`。交给系统 `ssh`（config / agent / 默认 identity）。
- **D3 连接档案是唯一入口**：不做手填 host 兼容。ssh 项目必须带 `sshConnectionId`。运行时 host 从档案现场解析（改档案上的 user/host/端口/密码，已有项目跟着变）。
- **D4 删除保护**：仍被未移除项目引用的连接不能删，提示先删/改项目。
- **D5 测试**：对档案执行 `true`（登录 + 能跑命令）。添加项目仍对路径做 `test -d`。

## Requirements

1. **R1 连接模型**：`SshConnection`：`id`、`name`、`host`（主机名或 ssh config 别名）、可选 `user`、可选 `port`（默认 22）、`auth: 'key' | 'password'`。密码只在 vault，按 `id` 取。
2. **R2 设置页**：新分类「SSH」。列表 + 增删改 + 每条「测试」。密码模式在钥匙串不可用时禁用并说明原因。
3. **R3 添加项目**：SSH tab 下拉已有连接 + 远端绝对路径；零连接时引导去设置。提交时用该档案探测路径。
4. **R4 项目权威**：ssh 必有非空 `sshConnectionId`；`sshHost` 改为由档案解析出的目标串（徽标/日志），创建与 spawn 都从档案现算，不接受无 id 的裸 host。
5. **R5 执行**：`buildSshExecArgs` / `SshExecutor` / `sshProbe` 按档案：`key` 仍 BatchMode；`password` 关 BatchMode、`SSH_ASKPASS_REQUIRE=force`、helper 从内存口令回答。可选 `-p port`。口令只在 main→worker 的内存 `remote` 里走，不写 registry / settings / jsonl。
6. **R6 IPC**：`sshConnections.list|upsert|delete|test`。list 无密码。test 走 D5。

## Acceptance Criteria

- AC1: 设置里可新增免密连接并测试成功（对本机已有密钥/config 的 host）。
- AC2: 钥匙串可用时可新增密码连接；重启后不用再输密码即可测试成功；list/设置 JSON/`source-registry.json` 均无明文密码。
- AC3: 钥匙串不可用时无法保存密码连接，有明确提示；免密仍可用。
- AC4: 添加远程项目只能选已有连接；探测失败不建项目；侧栏徽标显示该档案的目标 host。
- AC5: 改档案的 host/user/端口/密码后，已绑该档案的会话新工具调用走新参数。
- AC6: 删除仍被项目引用的连接失败并提示；删掉项目后可删连接，口令一并消失。
- AC7: 密码连接的 `ps`/argv 看不到口令；`key` 连接行为与现在 BatchMode 密钥登录一致。
- AC8: `pnpm typecheck && pnpm test` 通过；argv 构建、vault 加解密失败、parser、删除保护有先行测试。

## Out of Scope

- 私钥路径 / 密钥口令单独字段。
- 跳板机专用 UI（免密仍可吃 `~/.ssh/config` 的 ProxyJump）。
- 远端目录浏览、relay、Windows ControlMaster 专项。
- 编辑 `~/.ssh/config` 文件本身。
- 手填 host 旧项目迁移。
