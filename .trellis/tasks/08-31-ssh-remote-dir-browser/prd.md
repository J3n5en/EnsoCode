# SSH 添加项目支持远程目录浏览

## 背景

AddProjectDialog SSH 模式的「远程目录」是纯文本输入（仅校验 `/` 开头），
无法像本地模式那样浏览选择。main 已具备带 askpass 的 ssh 执行基建
（sshProbe.ts probeEnv + shared/ssh buildSshExecArgs），只缺列目录命令与 IPC。

## 方案

1. **纯函数（TDD）**：sshProbe 增加
   - `buildSshListDirsScript(path?)` — `cd <path|~> && pwd && find . -mindepth 1
     -maxdepth 1 -type d ! -name '.*'`（首行 pwd 解析真实绝对路径，支持 `~` 起点；
     隐藏目录不列，手输仍可用）
   - `parseSshListDirsOutput(stdout)` → `{ path, dirs: string[] }`（dirs 为名字，排序）
2. **main 执行**：`sshListRemoteDirs(host, path, options)` — execFile 捕获 stdout，
   失败复用 `classifySshProbeFailure`。
3. **IPC**：`SSH_CONNECTIONS_LIST_DIRS`（仅 main window），入参 `{ id, path? }`，
   出参 `{ ok, path, dirs } | { ok:false, error }`；preload `sshConnections.listDirs`。
   覆盖 fixture：excluded（渲染层选择器辅助，不进能力目录）。
4. **UI**：SSH 模式路径输入旁加 Browse；展开内嵌浏览面板（当前路径 + 上级 +
   子目录点击钻取 + 选择此目录），选中回填输入框。避免嵌套 Dialog。

## 验收

- typecheck/test/biome 绿；新纯函数用例覆盖 `~` 起点、绝对路径、空目录、脏输出。
- 密码连接经 askpass，密码不出 main。
