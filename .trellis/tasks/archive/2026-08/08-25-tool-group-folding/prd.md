# PRD: 工具行分组折叠(折中方案)

父任务: 08-25-chat-render-upgrade
前置: 08-25-timeline-virtualization(折叠行参与虚拟化的行模型)

## 需求(用户拍板的折中方案)

1. **运行中(流式)**:该轮工具行全部实时展示,不折叠。
2. **轮结束后**:连续 ≥3 条工具调用自动收拢为一条组头行:
   - 摘要文案:「N 个工具调用 · 跑了 X 条命令 · 读了 Y 个文件 · 搜了 Z 次」(有则显示,i18n)。
   - 点击组头展开/收起;展开后的行是列表数据行(参与虚拟化),非嵌套 DOM。
3. **edit 例外**:有文件改动的轮,diff 卡片保留在组头之外不折叠(改动是核心产物)。
4. **历史轮次**(resume 回来)默认全收拢。
5. 展开状态 per 会话内存记忆(不持久化)。

## 参考

ref-chat-a `MessagesTimeline.logic.ts`:`MAX_VISIBLE_WORK_LOG_ENTRIES`、`work-toggle` 行、`summarizeToolGroup`、`expandedWorkGroupIds`。

## 验收

- 一轮 8 个工具调用结束后收拢为 1 条组头 + diff 卡片;点击展开还原全部行。
- 流式中不发生收拢;轮结束瞬间收拢时无滚动跳动。
- buildTimeline 纯函数测试覆盖分组逻辑。
