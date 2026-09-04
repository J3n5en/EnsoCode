# Windows 本地命令壳设置

## 背景

`09-05-win-local-powershell` 把 Windows **本地**会话写死为官方 `powershell`。需要应用级开关，让用户在本机继续用 PowerShell，或改回 Git Bash；SSH 与非 Windows 不受影响。

## 目标

设置页增加一项 `windowsLocalShell`：`auto` | `powershell` | `bash`。Main 在 spawn 时读设置并传给 worker；选壳函数尊重该偏好，但远程会话永远 `bash`。

## 非目标

- 不改侧栏 `terminalService` 默认壳
- 不按项目覆盖
- 不让 renderer spawn 请求带壳字段（以 Main 读到的设置为准）
- 不默认同时暴露两个命令工具

## 需求

1. 缺省 `auto`：本地 win32 → `powershell`，其它与现在一致。
2. `powershell` / `bash` 只作用于 **本地 win32**；`remote` 或非 win32 仍 `bash`。
3. 脏值（缺字段、乱字符串）按 `auto`。
4. 新会话生效；已跑着的会话不热切换。
5. 设置页 General 可选；搜索能搜到。
6. Enso capability 可读写该字段。

## 验收

- `resolveSessionShellKind` 覆盖 auto / 强制 / 远程忽略。
- `parseAgentCommand` 接受合法枚举、拒绝脏值。
- `pnpm test`、`pnpm typecheck` 通过。
