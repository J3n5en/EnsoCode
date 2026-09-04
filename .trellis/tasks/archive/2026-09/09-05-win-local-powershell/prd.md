# Windows 本地 agent 用官方 PowerShell 替换 bash

## 背景

Enso 在 `supervisor` 里自己组装工具，本地会话一律 `createBashToolDefinition`。Windows 上 Pi 默认走 Git Bash，路径、`>/dev/null` 落 `nul`、`$` 展开都会踩坑。用户明确不要 WSL。Pi 0.84.3+（本仓库已是 `^0.84.3`）提供官方 `createPowerShellToolDefinition`。

## 目标

Windows **本地**会话只给模型一个命令工具：官方 `powershell`。审批、后台任务、checkpoint、Cursor exec 桥继续套在这个工具上。macOS / Linux / SSH 远端仍用 `bash`。

## 非目标

- 不装 `@4fu/pi-pwsh`、`pi-pwsh-native` 等社区扩展
- 不改用户 `~/.pi/agent/settings.json` 的 `defaultTools`
- 不改 `terminalService` 默认壳（cmd / COMSPEC）——另开任务
- 不上 persistent runspace / ConPTY sidecar
- 不把 SSH 远端改成 PowerShell
- 不默认同时暴露 `bash` + `powershell`

## 需求

1. 本地 `win32` 且非 SSH：注册 `createPowerShellToolDefinition`，不注册 `bash`。
2. SSH 或非 Windows：继续 `createBashToolDefinition`（远端仍 `remoteOps.bash`）。
3. `withBackground` / 审批 `command` / checkpoint 对 `powershell` 与 `bash` 同等生效。
4. Windows 后台任务不能走 Node `shell: true`（那是 `cmd.exe`），必须用官方 PowerShell 可执行文件拉起。
5. Cursor `shell` 帧：会话只有 `powershell` 时也能派发，事件里的工具名是实际工具。
6. 子代理 footer 不能只盯 `bash 0`；本轮没跑过命令工具时用中性的 `shell 0`。
7. 缺 PowerShell 时沿用 SDK 解析（`pwsh` 优先，否则 Windows PowerShell），不要默默回 Git Bash。

## 验收

- 单测覆盖：平台/SSH 选壳；`powershell` 触发 checkpoint；`withBackground` snippet 跟工具名；Cursor shell 回落到 `powershell`；footer `shell 0`。
- `pnpm test` 与 `pnpm typecheck` 通过。
- 不改 macOS/Linux 本地与 SSH 的工具名（仍为 `bash`）。
