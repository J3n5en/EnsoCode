# 后台任务收尾与闲置提醒 · mockup

只用于确认交互，不接产品代码。样式直接 `@import` 产品的 `globals.css` 与 `src/shared/theme` 派生的 token（内置 enso 主题），组件类名照抄 TaskBar / ToolCallCard / Sidebar / SecretaryDailyBoard。示例数据全部为假。

- 直接看：打开 `site/index.html`（`#dark` 切深色）。
- 重新生成：`node mockups/bg-task-cleanup/build.mjs && node mockups/bg-task-cleanup/shot.mjs`（需仓库 node_modules 与本机 Chrome；截图写到 `/tmp/bg-cleanup-mockup-<编号>-<light|dark>.png`）。

| 编号 | 画面 | 交互 |
| --- | --- | --- |
| A | 会话内任务条 | 三行：agent 写了理由的 iproxy（行内「保留：…」）、疑似闲置 42 分钟的 dev server（琥珀色，行内「保留」「停止」）、刚起的 vitest。展开闲置行看三条依据和最近输出；展开已保留行看理由原文，可「取消保留」。 |
| B | agent 收尾消息 | 一条「后台任务收尾」工具卡，徽标「停 2 · 留 1」，展开逐条列出停了什么、留了什么及理由；漏表态时系统先追加一行灰色提醒。 |
| C | 侧栏 | 会话行右侧计数：脉冲图标 N = 在跑，月亮图标 N（琥珀色）= 疑似闲置；悬停标记弹出任务卡，未打开的会话也能停。 |
| D | 所有在跑任务 | 入口：侧栏秘书下方的「后台任务」行。按会话分组，多选、整组勾选、「只看疑似闲置」筛选、批量停止。 |
| E | 批量停止确认 | 「停止所选」下方的非模态确认，列出任务名和所属会话；单个停止不确认。 |
| G | 秘书看板卡片 | 「已完成（N 个遗留任务）」卡片内列出遗留任务、理由或闲置时长，可逐个保留/停止。 |
