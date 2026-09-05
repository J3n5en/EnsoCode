# Implement: 侧边栏文件树右键菜单

## Order

1. **TDD 纯函数（inline 或 tester 切片）**
   - `assertEntryName`：合法名 / 分隔符 / `.` `..` / 空
   - `assertAllowedUrl` + `fileRoot`：工作区内 `file://` 过；cwd 外、`../`、无 fileRoot 的 `file:` 拒；http(s) 不变
   - 已有 `resolveUnderCwd` 保持绿
2. **Main files 突变**（`filesWorkspace` service + ipc + preload + types）
   - mkdir / create-file / rename / remove / abs-path|fileUrl / copy-path / copy-file / reveal
   - 每条先路径+名称校验；SSH 实现 mkdir/create/rename/remove/copy-path；copy-file/reveal/file 浏览器标 `unsupported`
   - 本地单测用 tmpdir fixture（已有 `filesWorkspace.test.ts` 风格）
3. **Browser 导航门**
   - `userNavigate` / `navigate` / will-navigate 传入 conversation 本地 cwd
   - `file:` tab 不写入 tabPersist
4. **FilesView UI**
   - 目录行、空白处、文件行菜单（分组 + separator + 条件隐藏）
   - 行内新建/重命名；删除用现有 `ConfirmDialog`
   - 突变后刷新树
   - Markdown 预览 tab
   - 浏览器：abs/fileUrl → `addSidePanelBrowser` → navigate
5. **i18n**：`src/shared/i18n.ts` 中英对照
6. **验证**：`pnpm exec vitest run` 相关测试；`pnpm typecheck`；`biome check` 改动文件

## Validation

```bash
pnpm exec vitest run src/main/services/filesWorkspace.test.ts src/shared/browser/urlPolicy.test.ts src/shared/browser/tabPersist.test.ts
pnpm typecheck
```

（名称函数若新建 `src/main/services/filesWorkspaceNames.test.ts` 一并跑。）

## Risky files

- `src/shared/browser/urlPolicy.ts` — 默认行为不能变松
- `src/main/services/browserHost.ts` — 所有导航入口必须带同一 fileRoot
- `src/main/ipc/filesWorkspace.ts` — 禁止渲染层绝对路径写盘
- `src/renderer/components/sidepanel/FilesView.tsx` — 已偏大，菜单/行内编辑可抽同目录小组件，但不要重构编辑器

## Rollback

还原 urlPolicy 与 browserHost 门；菜单 UI 可单独撤。

## Ready for start

- [x] prd / design / implement
- [ ] implement.jsonl / check.jsonl 实条目
- [ ] 用户批准本规划摘要后 `task.py start`
