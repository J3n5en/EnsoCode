# PRD: 会话打磨(轮次计时器/错误边界/高亮 LRU 缓存)

父任务: 08-25-chat-render-upgrade

## 需求

三个独立小项,可分别提交:

### 1. 运行中轮次计时器
- 会话 running 时,在时间线末尾的活动区显示已运行时长(如「12s」持续跳动)。
- 参考 ref-chat-a `WorkingTimer`:直接改 textNode,避免每秒 React commit 重渲染整个列表。
- 轮结束后计时器消失(数据已有 per-step timing,底栏/hover 条负责事后展示)。

### 2. 渲染错误边界
- 单条消息渲染抛错不白屏整个列表:每个 TimelineRow 包 ErrorBoundary,失败行显示紧凑错误占位(「此消息渲染失败」+ 复制原文按钮)。
- 参考 ref-chat-a `RenderErrorBoundary.tsx`。

### 3. 代码高亮 LRU 缓存
- shiki 高亮结果按 (code, lang, theme) 缓存,LRU 上限(条数+字节双限,参考 ref-chat-a 500 条/50MB)。
- 流式中的代码块不写缓存(内容还在变)。
- 应用到 CodeBlock(chat markdown)与 ReadFileView 共用的高亮路径。

## 验收

- running 时计时器每秒跳动且 React DevTools 无整表重渲染。
- 人为在某行抛错,其余消息正常渲染。
- 同一代码块二次渲染命中缓存(不重跑 shiki)。
