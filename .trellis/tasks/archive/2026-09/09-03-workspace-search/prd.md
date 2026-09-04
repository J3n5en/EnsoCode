# 工作区搜索 mod+k

## Goal

人用 `mod+k` 按标题、项目、正文找回任意会话（含未打开的冷会话），点一下跳转；当前会话内查找仍是 `mod+f`。

## Requirements

- 新快捷键动作 `search-workspace`，默认 `mod+k`。进 `KEYBINDING_ACTIONS` / `DEFAULT_KEYBINDINGS` / 设置页；capability 默认表同步。
- `mod+f` 只搜当前时间线，行为不变。
- 全局 Command Dialog（复用 `command.tsx`）。空查询：最近会话 + 常用动作（至少新建会话、打开设置）。有查询：混合检索。
- 可搜：会话标题、项目名、会话 id 前缀；用户/助手正文；工具名 + 截断后的关键参数。
- 冷会话：Main 用 pi `SessionManager.list` / `listAll` 的 `SessionInfo`（`name` / `firstMessage` / `allMessagesText`），按权威 `sessionFile` 过滤。禁止手写 jsonl 扫描器。禁止向量库。
- 默认范围：当前项目。可切全部项目 / 含归档。归档命中不自动取消归档。
- Coworker / child 命中：跳父会话并切对应 tab。
- 查询：去空白、大小写不敏感；CJK 子串，拉丁 token 前缀；标点当分隔符，不当查询语法。上限 50。
- 排序：标题精确 > 标题包含 > 当前项目正文 > 其他项目正文；同分 `lastActiveAt`。不用全文相关度当分主序。
- snippet ≤ 160 字。命中可带 `nearby`（前后各最多 2 句）。
- 默认只搜 leaf + 压缩后仍可见的正文（对齐 `allMessagesText` / 已 hydrate 投影）。旁支、已折叠原文第一版不搜。
- 排除系统/自定义 meta、纯 transport、空草稿。打开着的会话可命中，结果标「当前」。
- 远程节点态：与 `find-in-chat` 一样不响应本机搜索快捷键。
- 删除会话必须从冷索引摘掉。

## Acceptance Criteria

- [ ] `mod+k` 打开搜索面板；设置页能改绑定且不与 `mod+f` 冲突。
- [ ] 输入已知标题或一句用户原话，当前项目会话出现在结果里；点击切到该会话。
- [ ] 从未打开过的冷会话（registry 有 `sessionFile`）也能命中。
- [ ] 归档会话可命中且保持归档。
- [ ] coworker 命中打开父会话并切 tab。
- [ ] 空查询能看到最近会话并可跳转。
- [ ] 纯函数检索单测覆盖：排序、CJK/拉丁、标点消毒、范围、排除草稿、「当前」标记、上限 50。
- [ ] 冷索引 IPC：只收项目/范围标识，不收任意路径；脏输入不读盘。
- [ ] `pnpm typecheck && pnpm test` 绿；`biome check` 干净。

## Notes

不做：语义检索、搜 git 工作区源码、手机 search RPC、Inspector / Fork / 记忆。
