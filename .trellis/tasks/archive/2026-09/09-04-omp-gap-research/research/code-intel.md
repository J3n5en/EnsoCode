# 代码智能：oh-my-pi vs EnsoCode

来源：coworker `omp-intel`。

Enso 基线：`src/agent/tools/` 无 LSP/DAP；无编辑器 diagnostics；理解靠 grep + MCP 语义搜。

## 对方有而我们没有

### LSP 14 ops + LspMux
- diagnostics / definition / references / hover / symbols / rename / rename_file（willRenameFiles）/ code_actions / …
- 多 agent 共享 rust-analyzer/gopls。
- 难度：中高。**P0 先做 4 核 + mux。**
- 路径：`packages/coding-agent/src/lsp/`、`docs/tools/lsp.md`

### DAP 28 ops
- lldb / dlv / debugpy / js-debug。日常编码非刚需。**P2。**
- 路径：`src/dap/`、`tools/debug.ts`

### `/review` 流水线
- 滤 lockfile/dist；超阈值拆 reviewer；强制跨边界读消费端；P0–P3 + suggestion。
- 我们：只有 `reviewer` 提示词。**P0。**
- 路径：`extensibility/custom-commands/bundled/review/`、`prompts/agents/reviewer.md`

### `security_scan`
- Source→Sink + Codex Security。**P2 企业向。**

### `ast_grep` / `ast_edit`
- 50+ grammar，两阶段落地。**P1**，依赖 natives。

### Prewalk
- 规划用旗舰，首次 edit/write 后切 `@smol`。难度低。**P1。**
- 路径：`session/prewalk.ts`、`docs/prewalk.md`

### fs-scan-cache
- walker DashMap + 写后失效。**P2。**

## 双方都有

- reviewer 角色（只读）
- 用 bash 跑 tsc/cargo/eslint 保底

## 我们更强

- `tester` + `writeScope` 硬白名单（测文件才能写）
- coworker 长周期 review-fix UI

## Top 5

1. LSP 四核 + rename_file  
2. Prewalk  
3. `/review` 结构化  
4. LspMux  
5. ast_grep/ast_edit  
