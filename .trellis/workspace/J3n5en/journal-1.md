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


## Session 4: 重启后 coworker 级联恢复与死 tab 修复

**Date**: 2026-08-30
**Task**: 重启后 coworker 级联恢复与死 tab 修复
**Branch**: `dev`

### Summary

修复 39f4d3a 架构切换遗留：重启后 coworker 不恢复且死 tab 关不掉。落地 08-28 design §7.3 的 Main 级联恢复（restoreChildren + reserveChildResume + resume-coworker/dismiss-coworker 双形状过渡命令），dismiss 三段降级链，手动雇佣接 Main dispatch，child ended 终态落盘。真机验证发现并修复 resume 撞名自撞 bug；隔离环境完整走通雇佣→退出→重启→恢复→解雇链路。spec 沉淀两条铁律到 main/services.md。

### Git Commits

| Hash | Message |
|------|---------|
| `ca96deb` | (see git log) |
| `241fd72` | (see git log) |
| `5cd4575` | (see git log) |
| `46fe22d` | (see git log) |
| `68d09a1` | (see git log) |
| `0e8fc11` | (see git log) |
| `ad0f7b5` | (see git log) |

### Status

[OK] **Completed**


## Session 5: 移动端增强——推理档位 / 子任务输出 / Web Push 通知

**Date**: 2026-08-31
**Task**: 08-30-phone-enhancements（已归档）
**Branch**: `dev`

### Summary

移动端三连：① 新建会话直接设推理开关+档位（协议早已支持，补 UI 与校验）；
② 会话内查看 subagent/后台任务输出（taskProjection TDD + 复用桌面 TaskBar），
coworker 以头部 tab 条呈现（修复 catalog 不含子会话的死代码）；③ Web Push
桌面直发（VAPID 落盘 + SW + 订阅开关，relay 零改动），真机验证暴露 iOS 锁屏
半开 socket 误判在线——新增 presence 帧改门控为「离线或不可见」。追加置顶/
归档同步。新旧版本双向兼容（旧桌面时推送开关禁用并提示升级）。PWA 已部署。

### Git Commits

| Hash | Message |
|------|---------|
| `e04b91b` | feat(phone): 新建会话支持设置推理开关与档位 |
| `3d07118` | feat(phone): 会话内可查看 subagent 与后台任务输出 |
| `faa1124` | feat(pair/main): Web Push 通道 |
| `0eb193f` | feat(phone): Web Push 通知 SW 与订阅开关 |
| `9988712` | fix(phone): 旧桌面时推送开关禁用并提示升级 |
| `82bf409` | fix(phone): 换绑重置 VAPID |
| `98180f1` | fix(renderer): pair catalog 补发 coworker 子会话 |
| `73d76d7` | feat(phone): coworker 头部 tab 条 |
| `f51887b` | fix(pair): 推送门控改为「离线或不可见」 |
| `47c0180` | feat(phone): 置顶与归档同步到手机抽屉 |
| `f0f6f07` | style(phone): 归档栏对齐桌面 |
| `a0f543c` | fix(phone): 修复 JSX 注释构建失败 |

### Status

[OK] **Completed**

---

## Session: 2026-08-30 — pi 自动重试状态贯通（08-30-auto-retry-status）

### Summary

修复「503 报错解锁输入后 agent 又自己跑起来」的状态冲突。根因：pi SDK 内置
自动重试，supervisor 未消费 `agent_end.willRetry` / `auto_retry_start/end`，
把非终态误 settle 成 turn-completed。完整贯通：① supervisor 尊重 willRetry
（不 settle、终态错误改走 turn-failed、取消重试经 auto_retry_end 收口、
输入接管 = abortRetry + 新轮）；② 新事件 turn-retry + 命令 abort-retry 全链路
（shared 类型/narrowing → IPC → renderer reducer）；③ RetryBar 黄色横幅
（倒计时 + 可取消）；④ 瞬态错误渲染规则收进 buildTimeline 纯函数（紧跟
assistant = 已重试、末条且 running = 倒计时中，都不渲染）——同时解决实时
抽搐与 resume 回放重复红错，手机端复用同一函数天然生效；⑤ 手机端 RetryBar
（applyRetryEvent 纯投影，取消按钮改可选注入）。fake provider 增加 /__fail
端点，隔离环境真机验证成功/耗尽/回放三场景。relay 已部署。
spec 新增 big-question/pi-auto-retry-willretry.md。

### Git Commits

| Hash | Message |
|------|---------|
| `820d18a` | feat(shared,renderer): turn-retry 事件与 abort-retry 命令的类型与投影 |
| `11f05a9` | fix(agent): 尊重 pi 自动重试，重试期间不再误报轮次完成 |
| `b7e58ce` | feat(renderer): 自动重试状态条——倒计时展示与取消入口 |
| `61df9ac` | chore(scripts): fake provider 支持 /__fail 模拟连续 N 次 5xx |
| `6a69942` | fix(renderer): 瞬态错误只在真正终态渲染，覆盖实时与 resume 回放 |
| `ea4bb4e` | feat(phone): 手机第二屏显示自动重试横幅 |
| `e73e9ff` | docs(spec): 记录 pi 自动重试 willRetry 陷阱与瞬态内容渲染教训 |

### Status

[OK] **Completed** — typecheck/802 tests/biome 全绿，relay 部署版本 fcc28f80


## Session 6: dnd-kit 拖拽:项目排序 / 拖拽转 mention / 拖会话置顶 / Pinned 组内手动排序

**Date**: 2026-08-30
**Task**: dnd-kit 拖拽:项目排序 / 拖拽转 mention / 拖会话置顶 / Pinned 组内手动排序
**Branch**: `feat/dnd-kit-drag`

### Summary

侧栏引入 @dnd-kit(PR #36):项目行拖拽排序(localStorage 持久化)、会话/项目拖入 Composer 转 @过去会话/@文件 chip(项目用根绝对路径)、拖会话到 Pinned 区置顶、Pinned 组内手动拖排(与活跃时间自动排序分域共存)。routeDrop/applyProjectOrder/pinnedConversationIds 纯函数 TDD 共 28 例;修 dnd-kit 重复 id 隐患与 pointerWithin 碰撞策略。CDP 真机验证全部交互;沉淀 enso-cdp skill drag 命令与 big-question(窗口 hidden 丢弃 CDP 鼠标按键事件)。

### Git Commits

| Hash | Message |
|------|---------|
| `0df3fb6` | (see git log) |
| `2a106f3` | (see git log) |
| `1c59c9d` | (see git log) |
| `5f26e5e` | (see git log) |
| `9318826` | (see git log) |
| `2392450` | (see git log) |
| `12e11ff` | (see git log) |

### Status

[OK] **Completed**


## Session 7: 桌面端连接远程 EnsoCode 节点（guest 角色）

**Date**: 2026-09-02
**Task**: 桌面端连接远程 EnsoCode 节点（guest 角色）
**Branch**: `dev`

### Summary

对齐 Multica 多机模型：桌面 A 粘贴桌面 B 的配对链接即可作为 guest 连入 B，浏览/操控 B 的会话（列表、聊天、新建、审批/提问、模型切换）。复用现有 pair 中继与手机协议，零中继改动。main 新增 pairGuest/nodeStore/NODES_* IPC（凭据 safeStorage、与 pairHost 对称）；手机 client 的投影逻辑抽成 shared/pair/guestProjection 供两端共用；renderer 新增 remoteNodes store（纯 reducer + effects）、NodeSwitcher、RemoteNodeView，ChatHostContext 隔离时间线对本机 store 的直接读取；设置页「手机」扩为「设备」。协议加 host-info 帧作默认节点名，旧版 host 回落「节点 N」。同机双实例 + 真实中继 + fake provider 走完 AC1–AC10，修了 hostname 采用、重载后重订阅、远程态残留面板开关三处。加 ENSO_CDP_PORT 便于双实例验证。
## Session 7: worker 会话内存有界化：删除即 release + 闲置回收

**Date**: 2026-09-02
**Task**: Release idle worker sessions to bound agent memory
**Branch**: `main`

### Summary

排查「会话是否都塞在内存里」：renderer 侧刚修过（32KB 投影 cap + 只保留正在看的正文），但 agent worker 的 `SessionSupervisor.sessions` 只进不出——`release-parent` 仅 worktree 迁移调用；`removeConversation` 只 abort 不 release，删掉的会话成孤儿常驻到退出。修法：① 删除已启动 parent 走 `agent.release`；② worker 每 60s 扫描，idle 且无挂起 ask/approval/capability/后台任务/提醒/子会话、30 分钟无活动、未 pinned 的父会话在其串行门内重新校验后 release（reason `evicted`）；pinned 集合 = 桌面正在查看 + 手机在线订阅，由 Main 按来源分桶合并后 `pin-sessions` 全量下发，worker 重启后重发。`selectEvictable` 纯函数 TDD 7 例，supervisor 假时钟集成 2 例（做过变异检查确认能判别）。

### Git Commits

| Hash | Message |
|------|---------|
| `62c8ec8` | (see git log) |
| `69ab297` | (see git log) |
| `4bed2e7` | (see git log) |
| `021b2b3` | (see git log) |
| `267e899` | (see git log) |
| `a0872ec` | (see git log) |
| `6d158cd` | (see git log) |
| `32122d0` | (see git log) |
| `f4416ae` | (see git log) |
| `b6154d8` | (see git log) |
| `39f14c2` | (see git log) |
| `3703464` | (see git log) |
| `d30ff91` | (see git log) |
| `cbc1884` | (see git log) |

### Status

[OK] **Completed**
| `9a6b3ef` | fix(renderer): 删除已启动会话时 release worker 侧会话 |
| `d8ca346` | feat(agent): worker 闲置会话定期回收 + pin-sessions |

### Status

[OK] **Completed** — 相关测试 310 绿；全量 `pnpm test` 有 41 个 HEAD 上已存在的失败（electron CJS 命名导出 mock 问题，与本次无关）。


## Session 8: Browser Design Mode 圈选与涂鸦落地

**Date**: 2026-09-02
**Task**: Browser Design Mode 圈选与涂鸦落地


## Session 8: AI 会话标题总结：设置开关+独立模型+回退链

**Date**: 2026-09-02
**Task**: AI 会话标题总结：设置开关+独立模型+回退链
**Branch**: `dev`

### Summary

圈选落到主 Composer ui-element chip+绑定图；涂鸦冻帧可调裁切后只插无 id 附件图；修浮层遮挡/BoxSelect/冻帧丢 pointerup；Mermaid 改本地包并收紧 CSP。已归档 09-02-browser-design-mode 与 scribble。
新增会话标题总结功能：设置页开关+独立模型选择（settings v3 迁移），首条用户消息后经 Main 解析模型（标题模型→全局默认→会话模型回退链）由 worker completeSimple 生成短标题，title-generated 事件回流写回（手动改名守卫、失败静默）。TDD 共 29 个新用例；CDP 真机端到端验证通过（t+6s 出 AI 标题）。顺带确认两个既有问题：pairHost typecheck 错误与本机 ~55 个环境性测试失败均先于本次改动存在。

### Git Commits

| Hash | Message |
|------|---------|
| `e89b767` | (see git log) |
| `575ba9c` | (see git log) |
| `aa75b9d` | (see git log) |
| `8e8f135` | (see git log) |
| `cb68a58` | (see git log) |
| `8e5bdce` | (see git log) |

### Status

[OK] **Completed**


## Session 9: 归档已落地的侧栏与 SSH 任务

**Date**: 2026-09-02
**Task**: 归档已落地的侧栏与 SSH 任务
**Branch**: `dev`

### Summary

核对后归档 9 个已落地 in_progress：内嵌 Browser+DevTools、Changes/Files/Terminal、SSH 远程项目/连接/目录浏览、capability open-settings。active 清零。

### Git Commits

| Hash | Message |
|------|---------|
| `e89b767` | (see git log) |
| `575ba9c` | (see git log) |
| `aa75b9d` | (see git log) |
| `8e8f135` | (see git log) |
| `cb68a58` | (see git log) |
| `8e5bdce` | (see git log) |
| `f908812` | (see git log) |
| `dfb30b8` | (see git log) |

### Status

[OK] **Completed**


## Session 11: 归档已落地的侧栏全屏与系统代理

**Date**: 2026-09-03
**Task**: 归档已落地的侧栏全屏与系统代理
**Branch**: `dev`

### Summary

代码已合入 dev：侧栏全屏（铺满中间工作区、Esc/快捷键退出、空态顶栏按钮）与系统代理三层同步（Chromium / fetch / worker）。此前未走 archive，本轮补归档。

### Git Commits

| Hash | Message |
|------|---------|
| `fdf809f` | (see git log) |
| `8dfd539` | (see git log) |
| `ee00e8b` | (see git log) |
| `b837b84` | (see git log) |

### Status

[OK] **Completed**


## Session 12: 对话分支副本分叉与 B/C 归档

**Date**: 2026-09-03
**Task**: 对话分支副本分叉与 B/C 归档
**Branch**: `dev`

### Summary

pi createBranchedSession 会就地改源 SessionManager；改为打开源 jsonl 副本再分叉。归档 Context Inspector 与会话分叉子任务。父任务仍留搜索与项目记忆。

### Main Changes

- branchSessionFromPersistedFile：副本上分叉，源 sessionFile/内存树不动
- 登记并归档 09-03-context-inspector / 09-03-session-fork

### Git Commits

| Hash | Message |
|------|---------|
| `32dec92` | (see git log) |
| `e128a5f` | (see git log) |
| `503b342` | (see git log) |

### Testing

- [OK] vitest src/agent/sessionFork.test.ts 绿

### Status

[OK] **Completed**

### Next Steps

- 重启桌面后真机验证对话分支不吞源会话
- D 项目记忆填 Inspector 记忆桶


## Session 13: Usage statistics dashboard (Settings → Usage)

**Date**: 2026-09-04
**Task**: Usage statistics dashboard (Settings → Usage)
**Branch**: `enso/3085e88f`

### Summary

本地 pi session jsonl 解析 + catalog 定价估算 + 设置页用量 dashboard（统计卡/每日趋势/分时热力图/模型与项目排行）。TDD 角色分离（tester coworker 写红灯），reviewer 评审后修 DST 日边界、活跃时长按周期裁剪、异步扫描、零单价即未定价、请求竞态。真机 CDP 验证通过。

### Git Commits

| Hash | Message |
|------|---------|
| `9766e4f` | (see git log) |

### Status

[OK] **Completed**
