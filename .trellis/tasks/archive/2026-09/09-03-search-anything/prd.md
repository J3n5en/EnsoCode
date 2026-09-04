# Search Anything

## Goal

人用 `mod+k` 在同一面板找回对话（标题 **和** 正文）、浏览器标签、设置行，点一下跳到对应位置。`mod+f` 只搜当前时间线。

## Background

现有 `search-workspace`（默认 `mod+k`）只搜会话。设置是独立窗口、12 个分类、无深链（`openSettingsWindow` / `WINDOW_OPEN_SETTINGS`）。浏览器标签挂在会话 side panel，live 有 title/url，user tab persist `{url,title,conversationId,at}`，没有全局列表 IPC。命中后应切所属会话并 `addSidePanelBrowser`。远程节点态不响应本机 `search-workspace`。

本任务扩源，不重做 `src/shared/workspaceSearch.ts` 的会话排序/过滤契约。不做语义检索、源码搜索、手机/远程跨机搜索、设置内联改值、Inspector / Fork / 记忆。

## Requirements

- 快捷键仍是 `search-workspace` / 默认 `mod+k`，设置页可改绑，不与 `mod+f` 冲突。
- 有查询：结果按 Conversations / Browser / Settings 分组。对话组必须能搜标题 **和** 内容：用户/助手正文、工具名+截断参数；也可搜项目名、会话 id 前缀。沿用现有 workspace-search（当前项目默认、可切全部/含归档、冷会话的 `firstMessage`/`allMessagesText`、coworker 切父+tab。正文/工具命中跳转后预填 ChatFindBar）。不能变成只搜标题。
- 浏览器：搜所有会话 live + persist 的标题与 URL。命中切所属会话、打开 side panel、聚焦该 tab。
- 设置：搜具体行（标题 + 说明；已配置的具名条目含 provider / skill / MCP / SSH / instruction 名称）。命中打开设置窗口、切分类、滚到该行、闪几下。行有稳定 id。不得只打开设置首页。
- 空查询：最近会话 + 最近 3–5 个浏览器标签 + 至少「新建会话 / 打开设置」。
- 远程节点态按 `mod+k` 不打开本机面板。

## Acceptance Criteria

- [ ] `mod+k` 打开同一面板；已知对话标题能命中；一句只出现在正文里、不在标题里的用户原话也能命中并跳到该会话（含未打开过的冷会话），且预填 ChatFindBar。
- [ ] 已知浏览器标题或 URL 片段（其他会话或 persist 休眠）能命中；点击切所属会话并揭开该 tab。
- [ ] 设置词（如 Language / proxy / pairing）或已配置具名条目能命中；点击后设置窗口切到该分类、滚到该行并闪几下。
- [ ] 空查询可见最近会话、最近 3–5 个浏览器标签，以及新建会话、打开设置。
- [ ] 有查询时三类结果分组展示，不扁平混排。
- [ ] `mod+f` 不变；远程节点态 `mod+k` 不打开本机面板。
- [ ] 设置/浏览器检索纯函数有单测；`pnpm typecheck && pnpm test` 绿；`biome check` 干净。

## Decisions

- 设置：具体行 + 深链滚入 + 闪几下；面板里不改开关。
- 浏览器：所有会话 live + persist。
- 结果：按类型分组。
- 空查询：最近 3–5 个浏览器标签。
