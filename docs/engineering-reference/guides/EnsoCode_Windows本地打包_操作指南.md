# EnsoCode Windows 本地打包操作指南

适用于本仓库的 Windows x64 本地安装包。首次环境已准备好后，重复打包直接使用固定入口；仅在命令实际失败或构建配置发生变化时排查对应问题。

## 固定命令

在仓库根目录运行：

```powershell
node scripts/build-win-local.mjs
```

已能直接使用 pnpm 的终端也可以运行：

```powershell
pnpm build:win:local
```

脚本依次构建 Main、preload、renderer，然后生成 Windows x64 NSIS 安装包。输出到 `dist/win-local-<时间>/`，末尾显示安装包路径。自定义输出目录使用 `--output dist/<本次目录>`。

入口只调整构建子进程的环境，按需创建临时 pnpm 命令入口，完成后清理；不修改全局 PATH，不安装新依赖，不安装应用，不发布。版本沿用 `package.json`，不要为本地测试临时改版本。

## 重复打包的执行约定

1. 先确认打包的是用户指定工作区，简要告知本地已有改动也会进入产物。保护已有文件，输出使用独立目录。
2. 直接运行固定命令。已有验证证据仍适用于当前源码时复用；仅为打包不重复启动全仓审查、全量测试或多轮环境探测。
3. 以实际退出码和产物判断结果。完成后确认安装包非空、版本/架构正确、包内包含本次修复，并给出文件链接；未运行的验证不写成通过。
4. 真正失败时先读本次日志与下表，针对原因修复。不要依次尝试同一命令的后台、shell、REPL 等不同包装，也不要把空日志加退出码 0 当成成功。

需要核查原生依赖时，复用 `scripts/smoke-packaged-natives.cjs`，施加有限总超时；确认依赖实际从产物 `app.asar` / `app.asar.unpacked` 加载，防止从仓库的 `node_modules` 回退。原生验证超时只能记为未通过，不能据此重打相同安装包。

## 已确认的 Windows 构建环境问题

| 症状 | 已确认原因 | 固定处理 |
| --- | --- | --- |
| `pnpm` 不在 PATH，但 `corepack pnpm --version` 可用 | 宿主未提供 pnpm shim；electron-builder 的依赖收集器直接查找 pnpm | 本地入口用当前 Corepack 在临时目录创建 shim，仅给本次构建前插 PATH |
| `No JSON content found in output`，依赖列表为空且子命令退出码是 0 | 宿主未继承 `PATHEXT`。PowerShell 将 `.exe` / `.cmd` 当文档处理，可能没有运行预期命令 | 本地入口仅在缺失/空值时为 Windows 子进程补标准 `PATHEXT`，保留已有值 |
| 后台工具立即 exit 0、日志为空，`out/` 时间未变化 | 本次宿主调用发生过空执行；退出收据不证明构建完成 | 固定入口直接启动 Node CLI，保留输出及真实退出码；核对最终产物，不反复切换启动方式 |
| Node REPL 等待超时后内核重置，构建未产出安装包 | 本次构建由 REPL 子进程启动，等待超时打断了宿主执行链 | 优先通过正常终端/任务执行固定命令；异步执行时保留任务，使用完成通知，不用短超时重置内核 |
| 打包测试在 Windows 失败 | 已观察到 CRLF 与只匹配 LF 的正则不兼容、软链接 `EPERM`、POSIX 执行权限断言失败 | 阅读具体失败，区分测试可移植性与实际产物故障，不通过反复打包处理测试问题 |

`No JSON content found in output` 也可能有其他原因。这里的 `PATHEXT` 根因已通过“同一 PowerShell 子命令补值前无输出、补值后正确输出”验证；若固定入口后仍失败，再检查实际依赖收集输出。

## 产物与授权边界

- 安装文件为输出目录内的 `EnsoCode-Setup-<版本>.exe`；`win-unpacked/` 是同次应用目录，不能把旧目录当作新构建证据。
- 本地构建显式使用 `--publish never`。构建成功不代表已经安装或发布。
- 是否签名以安装包的 `Get-AuthenticodeSignature` 结果为准，构建日志中的 `signing` 字样不能证明有签名。
- 不覆盖或删除已有安装包。不要为了验证而启动会接管真实用户数据的打包版。
- asar 顶层应为 `out`、`node_modules`、`package.json`。不要添加只含排除项的 `win.files`，原因见 [平台 files 陷阱](../big-question/electron-builder-platform-files.md)。

## 相关入口

- [本地打包脚本](../../../scripts/build-win-local.mjs)
- [打包配置](../../../electron-builder.yml)
- [工程约定](../../engineering-guidelines.md)
