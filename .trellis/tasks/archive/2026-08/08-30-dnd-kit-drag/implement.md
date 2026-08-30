# 实施清单(每步独立 commit)

1. **项目顺序纯函数(TDD)**
   - 先写 `stores/settings/projectOrder.test.ts`(存量顺序/新项目追加/失效 id 剔除),Red → 实现 `projectOrder.ts` → Green。
2. **接入 dnd-kit + 项目拖拽排序(A)**
   - `pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/modifiers`
   - App.tsx 挂 DndContext(PointerSensor distance 6)+ DragOverlay
   - Sidebar 项目行 useSortable + SortableContext(限纵向),onDragEnd 写 localStorage
3. **Composer drop 通道(B+C)**
   - Composer 注册 insertMention 到共享入口;输入区 useDroppable + isOver 高亮
   - 会话行 useDraggable(携带 payload);项目行 payload 补 path
   - onDragEnd 路由:chat→composer 插 chat mention;project→composer 插 file mention(绝对路径)
4. **拖会话到 Pinned 置顶(D)**
   - Pinned 栏 useDroppable + isOver 高亮;无 Pinned 时拖 chat 出现临时落点条
   - onDragEnd:chat→pinned-zone → togglePinConversation
5. **收尾**
   - 拖拽中原行透明度/motion 协调检查

## 验证命令

- `pnpm typecheck && pnpm test`
- `pnpm exec biome check src/renderer`
- CDP 真机(`.agents/skills/enso-cdp`):四种交互各验一遍(HTML5 合成 drag 事件对 dnd-kit PointerSensor 无效,需用 CDP Input.dispatchMouseEvent 模拟真实 pointer 序列,或人工验证 + 截图)

## 风险文件

- `src/renderer/App.tsx`(DndContext 包裹)
- `src/renderer/components/chat/Sidebar.tsx`(已含 motion 动画,注意不回归)
- `src/renderer/components/chat/Composer.tsx` / `MentionEditor.tsx`(insertMention 暴露方式)

## 回滚点

A/B+C/D 各自独立 commit,可单独 revert。
