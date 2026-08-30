# 技术设计

## 架构

单一 `DndContext` 放在 `App.tsx`(包住 Sidebar 与 ChatView/Composer):

```
App.tsx
└─ DndContext (PointerSensor, activationConstraint: {distance: 6})
   ├─ Sidebar
   │  ├─ SortableContext(项目 id 列表, verticalListSortingStrategy)
   │  │  └─ 项目行 useSortable({id: `project:${id}`})
   │  ├─ 会话行 useDraggable({id: `chat:${id}`})   ← 非 sortable,纯 drag source
   │  └─ Pinned 栏 useDroppable({id: 'pinned-zone'})
   ├─ ChatView → Composer 输入区 useDroppable({id: 'composer'})
   └─ DragOverlay(拖拽中的行预览,半透明)
```

拖拽负载用 `data`(dnd-kit 的 `data.current`)携带类型化 payload:

```ts
type DragPayload =
  | { type: 'project'; projectId: string; path: string; name: string }
  | { type: 'chat'; conversationId: string; title: string; sessionFile?: string; pinned: boolean };
```

`onDragEnd` 在 App.tsx 统一路由:

| active.type | over.id | 动作 |
|---|---|---|
| project | 另一 project(sortable) | arrayMove → 存 localStorage |
| project | composer | `insertMention({kind:'file', relativePath: 项目绝对路径, ...})` |
| chat | composer | `insertMention({kind:'chat', sessionFile, ...})`(无 sessionFile / 自身会话 → no-op) |
| chat | pinned-zone | `togglePinConversation`(已置顶 no-op) |

## 数据流 / 契约

- **项目顺序**:新纯函数 `orderedProjects(projects, savedIds)`(建议放 `stores/settings/projectOrder.ts`):
  - savedIds 中存在的项目按 savedIds 顺序;
  - savedIds 里没有的(新项目)按投影原序追加末尾;
  - savedIds 中已不存在的项目 id 忽略。
  Sidebar 读 `localStorage['enso-project-order']`,`onDragEnd` 写回。
- **insertMention 跨树调用**:Composer 的 `editorRef` 在 ChatView 内部。方案:Composer 挂载时把 `insertMention` 注册到一个轻量 context/store(如 `useComposerDropStore`,zustand 或 React context),App 的 onDragEnd 从中取。避免把 ref 层层上提。
- **file mention 绝对路径**:`FileMentionCandidate.relativePath` 字段名不改(wire 只是 `@${path}`),传绝对路径即可;MentionChip 展示 label 用项目名。

## 与 framer-motion 的协调

- 项目行:dnd-kit sortable 自带 transform 过渡,项目行**不再包** motion layout(目前项目行本来就没包,只有会话行包了)。
- 会话行:`useDraggable` 拖动时原行保持原位(用 DragOverlay 显示预览),不与 `motion.div layout` 冲突;拖拽中给原行降透明度即可。

## 防误拖 / 可点击性

- `PointerSensor` + `activationConstraint: { distance: 6 }`:6px 内是点击,行内按钮、行 onClick 不受影响(Orca 用更复杂的时间+双采样,我们场景简单,距离阈值够用)。
- 键盘可达性:dnd-kit KeyboardSensor 暂不接(out of scope,后续可加)。

## 落点视觉反馈

- composer droppable:isOver 时输入框加 ring 高亮。
- pinned-zone:isOver 时栏目背景高亮;无置顶会话时侧栏顶部显示一个临时「拖到此处置顶」条(仅拖 chat 时出现)。
- 项目排序:sortable 默认位移动画 + DragOverlay。

## 风险 / 回滚

- DndContext 包整个 App 的性能:dnd-kit 静止时零开销,无风险。
- MentionEditor.insertMention 需要 editor 已聚焦?检查实现——若依赖 selection,drop 时先 focus 再插入。
- 回滚点:每个交互(A/B/C/D)独立提交,可单独 revert。
