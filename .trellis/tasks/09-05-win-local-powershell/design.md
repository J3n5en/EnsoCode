# 设计：会话命令工具选型

## 边界

行为住在 agent 工具组装层，不在 renderer / settings / IPC。

| 改 | 原因 |
|---|---|
| 新 `src/agent/sessionShell.ts` | 可单测的选壳 + 工厂，supervisor 不堆平台分支 |
| `supervisor.ts` | `buildBaseTools` 改走工厂 |
| `backgroundTasks.ts` | snippet 跟工具名；start 可指定可执行文件 |
| `checkpoint/manager.ts` | mutating 集合含 `powershell` |
| `runFooter.ts` | `bash 0` → `shell 0` |
| `cursor/execBridge.ts` | `shell` 帧回落到 `powershell` |

明确不改：`terminalService`、SSH `remoteOperations`、审批 kind 语义。

## 选壳

```
remote? → bash(+ remoteOps.bash)
else win32? → powershell
else → bash
```

`platform` 可注入，默认 `process.platform`。不探测 Git Bash，不双开。

## 包装

- 审批 kind 仍是 `command`，与名字无关。
- checkpoint：`write` / `edit` / `bash` / `powershell`。
- `withBackground.promptSnippet` 用 `definition.name`，不再写死 bash。
- 后台：`transform` 可带回 `{ file, argsPrefix }`。Windows 本地 powershell 用 `getPowerShellConfig()`（SDK：`-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`）。未指定则保持 `spawn(command, { shell: true })`。
- Cursor：`tools.get('bash') ?? tools.get('powershell')`，上报实际 `name`。

## 权衡

- 不复用社区扩展：任务模型会和现有 `BackgroundTaskManager` 打架。
- 工具名用官方 `powershell` 而不是伪装成 `bash`：模型才写 PowerShell。
- footer 改成 `shell 0`：macOS 文案也从 `bash 0` 变中性，只影响子代理脚注。

## 回滚

关掉 `sessionShell` 选型、supervisor 改回只建 bash 即可。包装层对 `powershell` 的兼容可留。
