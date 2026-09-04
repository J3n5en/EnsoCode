# 实施清单

1. RED/GREEN：`sessionShell.ts` — `createSessionCommandTool({ cwd, platform, remote })`。
2. `supervisor.buildBaseTools` 改用该工厂；SSH 仍传 `remoteOps.bash`。
3. `withBackground` snippet 用 `definition.name`；Windows powershell 后台走 `getPowerShellConfig()`。
4. checkpoint `MUTATING_TOOLS` 加 `powershell`。
5. `runFooter`：未出现 `bash`/`powershell` 时标 `shell 0`。
6. `execBridge`：`shell` 帧回落到 `powershell`，事件用实际工具名。
7. 验证：`pnpm test`、`pnpm typecheck`。

回滚点：每步可独立提交。失败则只回 supervisor 选壳。
