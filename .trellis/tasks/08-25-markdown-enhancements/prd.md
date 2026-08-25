# PRD: markdown 增强

父任务: 08-25-chat-render-upgrade

## 需求

对 chat 的 Markdown 渲染(assistant 正文)增强,参考 ref-chat-a `ChatMarkdown.tsx`:

1. **代码块复制按钮**(原清单 #4):代码块右上角 hover 出现复制按钮(带 ✓ 反馈);可选自动换行开关。
2. **文件路径 chip**:正文中的仓库内文件路径(如 `src/foo.ts:12`)渲染为可点 chip,点击用系统编辑器/内置 read 视图打开(实现方式 design 时定,MVP 可以先仅复制路径)。
3. **表格增强**:GFM 表格正确渲染 + hover 提供「复制为 Markdown」。
4. **GitHub alerts**:`> [!NOTE]` / `[!WARNING]` 等块渲染为着色提示框。

## 约束

- 现有 Markdown 组件与 shiki 高亮管线不推倒重来,逐项叠加。
- 全部 i18n。

## 验收

- 四项各有实机可见效果;复制按钮在流式中隐藏(内容未定)。
- 现有 markdown 渲染(列表/链接/行内代码)无回退。
