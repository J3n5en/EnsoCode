# Implement: 工具行分组折叠

1. [ ] timeline.ts:`TimelineItem` 加 `tool-group`;实现 `foldTimeline(items, running, expandedKeys)` 纯函数。
2. [ ] vitest:折叠门槛(≥3)、edit 例外、running 最后一轮不折、thinking 收组、展开输出 children。
3. [ ] TimelineRow.tsx:`ToolGroupRow`(摘要 + chevron),`onToggleGroup` prop,itemEqual 更新。
4. [ ] MessageTimeline.tsx:expandedKeys state + fold 接入。
5. [ ] i18n keys。
6. [ ] `pnpm typecheck && pnpm lint && pnpm test`;CDP 实机验证(历史会话收拢/展开、running 不折)。
7. [ ] 小步提交。
