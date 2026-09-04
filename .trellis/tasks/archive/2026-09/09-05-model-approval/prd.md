# 模型代审审批档

## Goal

在现有三档审批（全程审批 / 自动接受编辑 / 完全放行）之外，增加一档「助手代审」：用**全局设置**里用户指定的模型代替人做工具审批。低/中风险自动放行，高风险回问用户，严重风险拦截。**未选代审模型时该档不可用**，不回退当前会话模型。

## Background

当前 `ApprovalMode = supervised | auto-edits | full`。`full` 全免，`auto-edits` 只免文件写改，其余挂起等人。DeepChat 的「助手代审」（`auto_approve`）在本会挂起时用独立 `assistantModel` 做一次性风险评审，解析失败 / 超时 fail-closed 回问用户。本仓要对齐该能力，而不是做成第四种无条件放行。

## Requirements

- 审批选择器增加「助手代审」档，文案与状态栏、远程/手机新建会话保持同义。
- 代审模型是设置里的全局一项（落 `settings.json`，形状与 `defaultModel` 同为 `{ providerId, modelId }`）；交互放「模型服务」页，复用现有 `ModelPicker`，不在会话工具行里选模型。
- **未配置可用的代审模型时，不允许切入该档**：选择器项禁用并说明原因；spawn / set-approval-mode 也拒。不回退会话模型、不静默当 `full`。
- 该档下，**命令、文件写改、MCP** 都先走代审（对齐 DeepChat：`auto_approve` 对权限请求与可评审的 file/command 工具都评审，不是免文件）。`auto_allow` 放行；`ask_user` 弹出既有审批卡（可带简短理由）；`block` 按拒绝处理，本轮工具失败、会话继续。
- 风险硬门槛：`critical` 一律拦截；`high` 一律回问用户；仅 `low`/`medium` 可自动放行。
- 代审失败（超时、网络、非 JSON、action hash 对不上、缺风险等级）一律回问用户，不得放行。
- 用户 Abort / 会话终止仍 fail-closed 取消，代审进行中同样取消。
- 会话中途改档即时生效。设置里改代审模型对后续请求生效，不重评已挂起的真人审批。清空代审模型后，已处于该档的会话下一次需审时回问用户（fail-closed），并可在卡上写「请先在设置里选代审模型」。
- 已有三档行为不变；旧会话 / 旧协议缺字段不会被解成 `assistant`。
- 桌面 composer 与会话 spawn/resume 必须可用。手机配对与远程新建会话至少能选该档；模型本身只在桌面设置里选，远程/手机不为此新开模型选择器。

## Out of scope

- 不改 MCP sampling 或其它非工具审批通道。
- 不做会话级代审模型覆盖，也不回退会话模型。
- 不把代审做成子代理 / coworker（无工具、一次性补全即可）。
- 不引入 DeepChat 那套独立 ApprovalBroker 容量/去重框架。

## Acceptance Criteria

- [x] 设置→ 模型服务 可选「助手代审模型」；未选时审批选择器中「助手代审」禁用。
- [x] 已配置且模型可用时，可切入该档；审批选择器不再出现模型选择器。
- [x] `full` / `auto-edits` / `supervised` 单测与手工行为与改前一致。
- [x] 代审 JSON 规范化：`critical`→拒绝，`high` 或缺字段/坏 JSON/hash 错/超时→回问，`low|medium`+`auto_allow`→放行。
- [x] 代审进行中 UI 有可感知状态（审批卡或状态文案），完成后自动消失或转为真人审批卡。
- [x] 切换档位或代审模型后，下一次需审批的工具走新配置。
- [x] spawn / set-approval-mode 为 `assistant` 时，主进程必须能解决到可用的全局代审模型，否则拒命令或禁止切档；pair 能带新档字面量。
- [x] `pnpm typecheck`、相关单测、`src/shared/i18n.test.ts` 绿。

## Notes

- 参考实现：DeepChat `permissionMode=auto_approve` + `reviewAutoApproveAction` + `toolPermissionReviewer.ts` + 设置项 `assistantModel`。本仓与 DeepChat 的差异：未选代审模型时**不回退会话模型**，而是禁用该档。
- 安全原则沿用本仓 `ApprovalGate`：取消 / abort 永不放行。
