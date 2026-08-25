# PRD: 消息列表虚拟化与滚动跟随策略

父任务: 08-25-chat-render-upgrade

## 需求

1. 消息时间线改为虚拟化列表,长会话(500+ 消息、大量 diff/终端输出)滚动与流式更新不卡。
2. 滚动跟随三态(参考 ref-chat-a `timelineScrollAnchoring.ts`):
   - `following-end`:贴底时流式输出自动跟随。
   - `free-scrolling`:用户上滚(离底 > ~40px)即解除跟随,流式不抢滚;回到贴底自动恢复跟随。
   - 新一轮发送:把用户新消息锚到视口顶部(锚定留白),而非直接跳到底。
3. 「滚到底部」浮动按钮:非贴底时出现,点击平滑滚到末尾并恢复跟随。
4. 展开/折叠某行(工具输出、thinking)时保持该行视口位置,不引起跳动。

## 约束

- 现有 TimelineRow 渲染(EditDiff/TerminalOutput/ReadFileView/hover 条)不回退。
- 行高不定(diff 可很高),虚拟化方案必须支持动态测量。
- 技术选型在 design.md 定:candidates = @legendapp/list(ref-chat-a 用)/ virtua / @tanstack/react-virtual;按 React 19 兼容与动态高度支持评估。

## 验收

- 500 条消息会话滚动 60fps 不掉帧(DevTools Performance 抽查)。
- 流式回复时贴底跟随;上滚后不被拉回;浮动按钮可回底。
- 现有 16 个测试文件全过,timeline 快照渲染无回退。
