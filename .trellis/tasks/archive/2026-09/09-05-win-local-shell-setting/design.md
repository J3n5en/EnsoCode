# 设计

字段：`windowsLocalShell: 'auto' | 'powershell' | 'bash'`，默认 `auto`。

链路：Settings store → `settings.json` → Main `readSettingsState()` → `spawn-parent.windowsLocalShell` → `supervisor.spawn` → `createSessionCommandTool`。

选壳：`remote` 优先；否则仅 `platform === 'win32'` 看偏好；`auto`/`powershell` → powershell，`bash` → bash。

脏值归一在 `parseWindowsLocalShell`，设置水合与 worker 解析共用。
