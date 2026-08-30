# dnd-kit 拖拽:项目排序 + 会话/项目拖入 Composer 转 mention + 拖会话置顶

## Goal

侧栏引入 @dnd-kit,提供四种拖拽交互,让项目排序可控、引用过去会话/项目内容更顺手:

- **A. 项目排序**:侧栏内上下拖项目行,顺序持久化。
- **B. 会话 → Composer**:会话行拖进输入框,落成 @过去会话 chip。
- **C. 项目 → Composer**:项目行拖进输入框,落成 @文件 chip(项目根目录绝对路径)。
- **D. 会话 → Pinned 区**:会话行拖到顶部 Pinned 栏,置顶该会话。

## Background / Confirmed facts(代码证据)

- 项目列表来自 main 侧 authority 投影(`stores/settings/index.ts` `applyProjectAuthorityProjection`),按添加顺序,渲染侧无自定义 order。
- 会话侧栏各分组按「最后活跃时间倒序」自动排(`stores/sessions/pinned.ts`);因此**侧栏内不做会话手动排序**(D 只置顶,置顶组内仍自动排)。
- Mention 插入口现成:`MentionEditor.insertMention(candidate)`,支持
  `FileMentionCandidate {kind:'file', id, label, relativePath}` /
  `ChatMentionCandidate {kind:'chat', id, label, sessionFile}`。
- wire 格式(`mentionComposer.ts serializeSegments`):file 段 → `@${path}`(agent 自行读取,**绝对路径可行**,C 用项目根绝对路径);chat 段 → 内联引用块(需 `sessionFile`,root 会话且 jsonl 存在,见 `useMentionSearch.toChatMentionCandidates` 的过滤条件)。
- Sidebar 挂在 `App.tsx`,Composer 挂在 `ChatView.tsx`,共同祖先为 App → DndContext 放 `App.tsx`。
- 已装 framer-motion(行 layout 动画);dnd-kit 未装。
- 参考实现:Orca(@dnd-kit,自定义 PointerSensor 防误拖 + DragOverlay 预览);DeepChat(handle 限定、ghost 样式)。

## Requirements

- R1(A)项目行可拖拽重排,仅纵向;顺序存渲染侧 localStorage(`enso-project-order`,与 `enso-collapsed-projects` 同策略);新项目追加在末尾;排序合并逻辑为纯函数。
- R2(B)会话行可拖出侧栏,落到 Composer 输入区时调用 `insertMention(chat candidate)`;仅 root 会话且有 `sessionFile` 的可拖出(与 @ 弹层同过滤);当前会话拖入自身输入框不插入。
- R3(C)项目行拖到 Composer 输入区时插入 file candidate,path 为项目根绝对路径。
- R4(D)会话行拖到 Pinned 栏目区域松手 → `togglePinConversation` 置顶(已置顶的不重复切换);Pinned 区不存在时(无置顶会话)不提供该落点。
- R5 拖拽启动需 distance 阈值(约 6px)防误拖,不能干扰行的点击/hover 按钮;拖拽中有视觉反馈(DragOverlay 半透明预览 + 落点高亮)。
- R6 拖拽重排动画与既有 framer-motion `layout` 动画不冲突(拖拽中禁用 layout 动画或二者协调)。

## Acceptance criteria

- AC1 拖动项目 A 到项目 B 下方松手,顺序变更且刷新后保持;新添加的项目出现在列表末尾。
- AC2 把某历史会话行拖进输入框,输入框出现该会话的 chip,发送后 wire text 含内联 chat 引用块。
- AC3 把项目行拖进输入框,出现 @<项目绝对路径> chip,发送后 agent 可按该路径读取。
- AC4 把未置顶会话拖到 Pinned 栏,该会话 pinned=true 并出现在 Pinned 栏。
- AC5 单击会话/项目行为不受影响(不误触发拖拽);行内按钮(置顶/归档/删除等)照常可点。
- AC6 排序合并纯函数有单测(TDD):已存 order 优先、缺失 id 剔除、新项目追加。
- AC7 `pnpm typecheck && pnpm test` 通过,biome 干净;CDP 真机验证四种交互。

## Key decisions

- 库:@dnd-kit/core + @dnd-kit/sortable(+ modifiers 限纵向),用户指定;为后续跨容器拖拽留路。
- 会话侧栏内不做手动排序(与活跃时间自动排序冲突);D 仅改 pinned 标志。
- 项目顺序存 localStorage 而非 settings:侧栏只在主窗口,无跨窗口同步需求;代价是换机器不带走。
- C 用绝对路径而非 relativePath:跨项目拖入时 cwd 相对路径不可达。

## Out of scope

- 会话跨项目移动(改归属/cwd/worktree)。
- 会话在项目分组内手动排序。
- Pinned 组内手动排序。
- 文件树/单文件级别的拖入(只有项目根)。
