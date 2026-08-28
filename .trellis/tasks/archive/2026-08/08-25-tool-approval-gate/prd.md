# PRD: 工具审批门(权限系统)

## 背景

agent 目前对 bash/edit/write/MCP 零确认直接执行。参考 ref-chat-a / deepseek-harness / ref-chat-b 调研(见任务 research 结论,三家共识:模式档位为主策略、不做累积式命令白名单、拒绝=isError 工具结果回喂、composer 区审批条、fail-closed)。

## 需求

1. **三档模式**(per 会话记忆,composer 工具栏选择器):
   - `supervised`(**默认**,用户拍板):bash / edit / write / 全部 MCP 工具执行前须审批;
   - `auto-edits`:edit/write 免审,bash 与 MCP 仍审;
   - `full`:全放行(现状行为)。
   - read/grep/find/ls/todo 恒免审;MCP 工具不信任远端只读声明,一律当写操作(ref-chat-b 教训)。
   - 会话中途可切换,立即生效。
2. **决策三选**:允许一次 / 本会话总是允许(工具名级,进程内记忆) / 拒绝(模型收到 isError「User denied this operation」,轮继续)。
3. **审批 UI**(ref-chat-a 式):composer 上方警示条;bash 显示命令全文(可滚动不截断),edit/write 显示路径,MCP 显示工具名+参数摘要;一次显示队首,>1 显示 1/N;**有 pending 时输入框锁定**(用户拍板)。
4. **fail-closed**:abort/停会话/worker 退出时全部 pending 按取消收尾(isError 回喂);渲染层刷新后 pending 从 worker snapshot 恢复,不会永久卡死。

## 不做(本期)

- 命令模式白名单/持久化允许规则(三家共识不做);
- LLM 代审档(ref-chat-b auto_approve);
- 沙箱。

## 验收

- supervised 会话:bash 调用弹审批条、输入框锁定;允许后执行、拒绝后模型收到错误并继续;「本会话总是允许」后同工具不再询问。
- auto-edits:edit 直接执行,bash 仍拦。
- 中途 abort:审批条消失,工具结果为取消错误。
- 刷新页面后 pending 审批条恢复。
- 全绿 + CDP 实机验证。
