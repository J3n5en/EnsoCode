# Implement: 消息列表虚拟化与滚动跟随

## 执行清单

1. [ ] `pnpm add react-virtuoso`;确认 React 19 peer 无警告。
2. [ ] 读现有 ChatView.tsx 的消息滚动容器(map TimelineRow 的段落)与自动滚动逻辑(如有),摸清替换边界。
3. [ ] 新建 `src/renderer/components/chat/MessageTimeline.tsx`:Virtuoso 封装(design.md 结构),`computeItemKey` 用 item.key。
4. [ ] follow 派生逻辑抽纯函数(`atBottom × running → followOutput`),vitest 覆盖。
5. [ ] ChatView 接入替换,删除旧滚动容器与旧自动滚动代码。
6. [ ] 发送新消息时 `scrollToIndex` 锚顶(ref 方法)。
7. [ ] ScrollToBottomButton:`!atBottom` 显示,点击 `scrollToIndex(last, smooth)`。
8. [ ] `pnpm typecheck && pnpm lint && pnpm test`。
9. [ ] CDP 实机验证:流式贴底跟随/上滚不抢滚/浮动按钮/展开 diff 不跳动/切换会话定位到底。
10. [ ] 小步提交(依赖引入与组件接入可分两笔)。

## 回滚点

组件级替换,单文件 revert 即回旧渲染;不动 buildTimeline/TimelineRow。

## 验证命令

- `pnpm typecheck && pnpm lint && pnpm test`
- CDP: http://localhost:9222 (dev 运行中)
