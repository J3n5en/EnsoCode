# Journal - J3n5en (Part 1)

> AI development session journal
> Started: 2026-08-24

---



## Session 1: model-center-default-agent 真机验证：7 个 bug 修复与 spec 沉淀

**Date**: 2026-08-29
**Task**: model-center-default-agent 真机验证：7 个 bug 修复与 spec 沉淀
**Branch**: `feature/model-center-default-agent`

### Summary

对已标称完成的实现做 Phase 2.2 全量质量检查与真机动态验证。静态门禁全绿，但真机首跑连一个会话都起不来。共定位并修复 7 个 bug：spawn 命令解析漏 settingsProviderId 导致全部会话无法启动且无任何日志（致命）；多窗口设置广播死循环打满两个渲染进程 CPU；registry 缺 Main handler 使 @ 候选必空；receipt 关联键用了不同命名空间的 id 致完成通知永远无 summary；能力授权误用 turnId 作键，跨内部 agent turn 静默失效；enso_app 的 params 未声明类型 + custom agent type id 口径不通，导致能力对 Claude 完全不可用；纯派发父容器因 pi 的落盘启发式从不写文件，重启后整个会话连同 child 历史打不开。每个修复均配可观测行为的回归测试并反向验证过。真机验证通过 AC11/15/17/19/21/22/24/27/29/30/32/33。剩余 child TAB 正文回放拆为子任务 08-29-child-history-replay。

### Git Commits

| Hash | Message |
|------|---------|
| `ec971b1` | (see git log) |
| `5bf52ae` | (see git log) |
| `743e172` | (see git log) |
| `598a362` | (see git log) |
| `a800f3a` | (see git log) |
| `0d8f9dd` | (see git log) |
| `64d27c5` | (see git log) |
| `a0e78cb` | (see git log) |
| `efddd2a` | (see git log) |

### Status

[OK] **Completed**


## Session 2: child-history-replay：重启后已结束 child 的只读历史回放

**Date**: 2026-08-29
**Task**: child-history-replay：重启后已结束 child 的只读历史回放
**Branch**: `feature/model-center-default-agent`

### Summary

补齐父任务 R10 的另一半：safe journal 在磁盘上完好但缺回放通道，导致重启后 child TAB 恢复了却是空的。按 Main 读取 + 渲染层惰性投影 + 只读的方向实现。安全上渲染层只传 conversationId，路径一律由 Main 从持久化会话推导并叠加目录内与 enso- 前缀两道校验，配 6 条恶意输入用例。只读不复活：不进 sessionIndex、不占容量、不注册能力授权，child 身份守卫原样保留。实现中自查发现拒绝判断放在乐观回显之后会往只读历史插一条从未发出的用户消息，已前移并让测试断言消息数不变（反向验证过）。真机（claude-opus-5）：派发→优雅退出→重启→切 TAB，任务原文/助手回复/receipt 全部恢复；发送被拦且消息数未变；回放后仍能连续派发 5 个 child 确认未占容量。

### Git Commits

| Hash | Message |
|------|---------|
| `9ff8c48` | (see git log) |
| `43812e2` | (see git log) |

### Status

[OK] **Completed**


## Session 3: 子代理指定模型 + ask 通知修复 + 侧栏置顶/归档

**Date**: 2026-08-30
**Task**: 子代理指定模型 + ask 通知修复 + 侧栏置顶/归档
**Branch**: `dev`

### Summary

subagent/coworker 支持主 agent 按任务指定模型:设置页「允许子代理指定模型」开关+模型/描述列表,凭证 main 解析随 spawn 下发,工具 schema 与 promptSnippet 注入选型引导(开关关闭零暴露)。修复 ask_user 未聚焦不弹系统通知并补 maybeNotify 回归测试。侧栏新增会话置顶/归档:纯排序函数可测,右键菜单删除,归档栏固定底部向上展开。

### Git Commits

| Hash | Message |
|------|---------|
| `01dc99c` | (see git log) |
| `0bad2f9` | (see git log) |
| `ef9c928` | (see git log) |
| `07e9a04` | (see git log) |
| `58c99f5` | (see git log) |
| `e898e80` | (see git log) |
| `2d67e8c` | (see git log) |
| `c854b38` | (see git log) |
| `4f0a1d3` | (see git log) |
| `9bece08` | (see git log) |

### Status

[OK] **Completed**
