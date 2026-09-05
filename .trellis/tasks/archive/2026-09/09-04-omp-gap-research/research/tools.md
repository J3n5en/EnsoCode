# 工具面：oh-my-pi vs EnsoCode

来源：coworker `omp-tools`。对照 `oh-my-pi/packages/coding-agent/src/tools/` 与 Enso `src/agent/tools/`、`src/shared/types/builtinTools.ts`。

## 对方有而我们没有 / 或明显更强

### Hashline `edit` + `ast_edit`
- 4 字节内容锚点 + `PUT`/`CUT`/`MV`；文件被改则拒补丁。`ast_edit` 先预览再 `xd://resolve`。
- 我们：pi 的 search-replace `edit`。
- 难度：中（Hashline 可移植 TS；AST 要 natives）。**值得抄 Hashline。**
- 路径：`packages/hashline/`、`packages/coding-agent/src/edit/`、`docs/tools/edit.md`

### 万能 `read`
- zip/tar 内路径、SQLite 表/SQL、PDF→markdown+页内图、大文件 AST 折叠、`.cpuprofile`。
- 我们：文本截断 + 图片。
- 难度：中。**值得抄**（先 SQLite/zip）。
- 路径：`packages/coding-agent/src/tools/read.ts`、`read-sqlite.ts`、`read-pdf.ts`、`read-archive.ts`

### `eval` + tool 重入
- 持久 py/js/rb/jl；代码里 `tool.*` / `agent()` / `completion()`。
- 我们：无状态 `bash`。
- 难度：中高。**后续讨论**（≈ OpenClaw/Codex code mode；先不对齐实现）。
- 路径：`packages/coding-agent/src/tools/eval.ts`、`src/eval/agent-bridge.ts`

### `conflict://`
- `read conflict://1/ours|theirs|base`，`write conflict://*` 批量 `@ours`。
- 难度：低。**值得抄。**
- 路径：`tools/conflict-detect.ts`

### `xd://` 二线工具总线
- 次要工具不当顶层 function。工具少时不必上。**可观望。**

### `computer` 桌面 AX
- 窗口/截屏/原生输入/辅助功能树。难度高、安全面大。**可观望。**
- 路径：`crates/pi-natives/src/desktop/`、`tools/computer.ts`

### 其它
- `web_search` 多 provider 降级；`pr://` `issue://`；`security_scan`；tts/生图/inspect_image。

## 双方都有

- `bash`：对方进程内 coreutils + interceptor + glob 审批；我们有后台任务与 GUI 审批。
- `grep`：对方输出带 Hashline 锚点 + `ast_grep`；我们有文本 grep + MCP 语义搜。
- 子代理结果：对方 `agent://` 文件化；我们 coworker/subagent 内存 IPC。

## 我们更强

- coworker 多轮 Tab + 人工介入
- 内置 Electron 浏览器（相对外挂 Puppeteer）
- GUI 审批 / 后台任务

## Top 5

1. Hashline  
2. `conflict://`  
3. `bashInterceptor`  
4. `read` 直读 SQLite/zip  
5. `eval` + tool 重入  
