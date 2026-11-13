# 本机配置 CLI（`enso config`）

让脚本或 AI 在 EnsoCode 运行时直接改设置，改完立即生效，不用点设置页，也不用重启。

CLI 不碰 `settings.json`：设置的权威副本在 Main 进程内存里，外部直接改文件会被下一次写盘覆盖。CLI 把请求发给运行中的 Main，由 Main 走设置页同一条写入路径。

## 命令

```bash
enso config get <key>              # 输出该键的 JSON 值
enso config set <key> <value>      # value 按 JSON 解析（15、true、"dark"），解析失败按字符串处理
enso config list [prefix]          # 列出全部设置键与当前值；prefix 带点号时只看该子树
enso config reload                 # 运行中的应用丢弃内存副本、重新读盘并广播
enso config help                   # 人类可读帮助（也可用 enso --help / enso config -h），应用未运行也能打印
enso config help --json            # 机器可读 schema（别名 enso config schema），需应用在运行
```

选项：`--data-dir <dir>` 指定 userData（也可用环境变量 `ENSO_USER_DATA_DIR`）；`--dev` 连接开发版（`enso-code-dev`）。
在仓库里可以直接运行 `node scripts/enso-cli.mjs ...`，全局安装后命令名是 `enso`。

返回值都是 JSON。成功为 `{ "ok": true, ... }`，失败为 `{ "ok": false, "error": "..." }`，退出码非 0。

## 机器可读 help（给 LLM）

`enso config help --json` 向运行中的 Main 发送只读请求 `{ action: "schema" }`，CLI 只负责拼上命令清单并格式化输出：

- `commands`：每个命令的 `name`、`usage`、`args`、`description`、`examples`；`options` 为全局选项。
- `keys`：由 Main 遍历 `SETTINGS_STATE_FIELDS` 与当前 settings state 生成（不含任何值），每项 `{ path, type, writable, requiresRestart, secret }`。数组元素以 `<id>`（或 `<index>`）占位，如 `providers.<id>.baseUrl`；最深 4 段；未写入 state 的字段 `type` 为 `unknown`。`writable` 与 `set` 的拒绝规则一致。
- `blacklist`：密钥键名正则与说明、路径/命令规则、`writeDeniedFields`、`entryLevelDeniedFields`、`readDeniedFields` 和被拒的非设置操作清单。
- `notes`：热生效说明、需重启键及原因、socket/token 机制、键格式。

应用未运行时 `help --json` 退出码 1，并提示需要先启动 EnsoCode。

## 键格式

键 = `<设置字段>[.<子键>...]`，第一段必须是 Main 登记过的设置字段（`SETTINGS_STATE_FIELDS`）。遇到数组时，下一段按元素 `id` 定位，找不到再按下标。

```bash
enso config set theme dark
enso config set terminalFontSize 15
enso config set chatTypography.body.size 15
enso config set proxyMode custom
enso config set customProxyUrl http://127.0.0.1:7890
enso config set providers.<id>.baseUrl https://api.example.com/v1
enso config set defaultModel '{"providerId":"<id>","modelId":"gpt-5"}'
enso config set mcpServers.<id>.callTimeoutSec 120
enso config set subagentModelsEnabled true
enso config set memoryDistillEnabled true
enso config get providers.<id>            # apiKey、Authorization 等显示为 ***
```

写入时会检查类型：键已有值时，新值的 JSON 类型必须一致（对象类型的键可以写 `null`）。`proxyMode`、`customProxyUrl`、`language` 另有取值校验。数组只能改已有元素，不能通过子键追加。

## 黑名单

除了下面这些，其余设置键都能读写。

| 类别 | 规则 | get / list | set |
| --- | --- | --- | --- |
| 密钥和凭据 | 任一段键名匹配 `apiKey`、`api_key`、`secret`、`password`、`credential`、`authorization`、`cookie`、`*token`，或键名就是 `env`（MCP 环境变量）。例如 `providers.<id>.apiKey`、`providers.<id>.headers.Authorization`、`voiceGeminiApiKey`、`mcpServers.<id>.env` | `get` 返回 `{ ok: false, hidden: true }`；`list` 和父对象中显示为 `***` | 拒绝 |
| 文件路径 | `worktreeRoot`、`backgroundImagePath`、`backgroundFolderPath`，以及任一段是 `path`、`dir`、`root`、`cwd` 或以 `Path`、`Dir`、`Root` 结尾的键 | 可读 | 拒绝 |
| 执行命令 | `terminalShell`、`windowsLocalShell`、`fileOpenRules`、`contextMenuOpen`，以及任一段是 `command` 或 `args` 的键（例如 MCP 的启动命令） | 可读 | 拒绝 |
| 插件 / 技能装卸 | 整体替换或增删 `plugins`、`skills`、`instructions` 的条目 | 可读 | 拒绝；条目内的字段（如 `plugins.<id>.enabled`）可以写 |
| 项目数据 | `projects`、`projectGroups`，由 Main 权威投影维护 | 拒绝 | 拒绝 |
| 未登记字段 | 第一段不是设置字段 | 拒绝 | 拒绝 |

整体写入父对象时，只要原值或新值里含有上述密钥、路径、命令键，也会被拒绝。例如 `set providers.<id> {...}` 会冲掉 `apiKey`，所以不允许，只能改叶子键。

记忆远程向量化不单独保存凭据：它通过 `memoryEmbeddingRemoteProviderId` 引用 provider，并使用该 provider 的 `apiKey`。这个 `apiKey` 已在黑名单内；`memoryEmbeddingRemoteProviderId` 只是引用，可以写。

密钥只能在设置页里修改。

## 热生效与需重启

`set` 调用 Main 的 `patchSettingsState`，和设置页写入走同一条路径：

1. 更新 Main 内存里的权威副本，并防抖原子落盘；
2. 向所有窗口广播 `SETTINGS_CHANGED`，renderer 重读后生效；
3. 把模型目录、web 搜索、审批、压缩、重试、工具开关等配置推给 agent worker，同时同步记忆、语音、托盘快捷键和界面语言；
4. 写 `proxyMode` 或 `customProxyUrl` 后，再调用设置页使用的代理应用逻辑（会话代理、进程环境、worker 环境）。

部分设置本来就只对新会话生效，例如 `subagentModels`、`subagentAllowedModes`、`editMode`、`rtkEnabled`。CLI 写入后，它们的行为与在设置页修改一致。

以下键由更新器在启动时读取，设置页修改时还会另外调用专用 IPC，只改设置不会生效：

- `autoUpdate`、`autoRestartWhenIdle`

对这些键执行 `set` 会返回 `{ "ok": false, "requiresRestart": true, "reason": "..." }`，并且不会写入。请在设置页切换，或重启应用。

## 安全边界

- **只监听本机**：macOS 和 Linux 使用 Unix domain socket `<userData>/cli/cli.sock`，目录权限 0700，socket 权限 0600；Windows 使用按 userData 区分的命名管道 `\\.\pipe\enso-code-cli-<hash>`。不开任何 TCP 端口。
- **token**：每次启动生成 32 字节随机 token，写入 `<userData>/cli-token`（0600）。每个请求都必须带 token，Main 用常量时间比较，校验失败一律返回 `unauthorized`。
- **只做 config**：socket 只接受 `cmd: "config"` 的 get、set、list、reload、schema（只读，不含值），不提供插件安装、会话读写或执行命令。
- **密钥不出 Main**：所有读路径都会递归脱敏，密钥类键名的值替换为 `***`。
- **请求上限**：单个连接超过 1 MiB 会被断开。
- **退出清理**：应用退出（`before-quit`）时关闭监听，并删除 socket 文件和 `cli-token`。

## 新增设置项时必须同步

新增或修改 `SETTINGS_STATE_FIELDS` 中的字段时逐条检查：

1. **自动出现**：新字段无需手动登记，会自动出现在 `enso config list` 与 `enso config help --json` 的 `keys` 里（从 state 生成），`writable` / `secret` / `requiresRestart` 按 `policy.ts` 规则计算。
2. **密钥 / 路径 / 执行类**：键名不被 `SECRET_NAME`、`PATH_OR_EXEC_NAME` 命中但实际存放凭据、文件路径或可执行入口时，必须加进 `src/main/services/configCli/policy.ts` 的 `WRITE_DENIED`（或调整正则）；项目/会话数据加进 `READ_DENIED`；条目增删等同安装卸载的加进 `ENTRY_LEVEL_DENIED`。
3. **启动时读入**：只在启动时读取、或设置页另走专用 IPC 才生效的字段，必须加进 `RESTART_REQUIRED` 并写明原因。
4. **取值校验**：有枚举或格式约束的字段，在 `validateField` 中补校验。
5. **单测**：在 `src/main/services/configCli/server.test.ts` 补一条断言，新字段可被 `set` 并生效，或按上述规则被拒（`schema` 中对应 `writable` / `secret` / `requiresRestart` 正确）。
6. **文档**：本文黑名单表或「热生效与需重启」列表随之更新。
