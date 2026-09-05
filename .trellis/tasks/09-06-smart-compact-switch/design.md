# Design: Smart compact optional switch

## Behavior gap

现在：`/compact` 与自动压缩都是 `session.compact()`，摘要完全交给 Pi 原生 summarizer。

应该：设置打开时，父会话加载 `pi-smart-compact`，它在 `session_before_compact` 里产出验过的摘要并交给宿主 apply；关或失败则原生。

行为住在 **agent worker 的 `createAgentSession` resource loader**，不是渲染层自己摘要。

## Integration (not a second compact engine)

```
设置 smartCompactEnabled
  → persist settings.json
  → 下次 spawn-parent 带 smartCompactEnabled
  → supervisor 给 DefaultResourceLoader.additionalExtensionPaths
  → Pi 加载 npm:pi-smart-compact
  → session.compact() / 自动 compact
  → session_before_compact（扩展）stage
  → session_compact（Pi apply）
```

失败路径由扩展自己 fail-closed；加载失败由我们吞掉扩展、不挡 spawn。

## Settings

| 项 | 值 |
| --- | --- |
| 字段 | `smartCompactEnabled: boolean`；`smartCompactModel: DefaultModelRef \| null` |
| 模型 | `null` = 跟随会话模型。选定后 spawn 写入扩展 `summaryModel`（`oauthAccountKey/modelId` 或 worker 注册 id） |
| 默认 | `false` |
| UI | `GeneralSettings` 新一行（agent 行为，不是时间线密度） |
| 主进程读 | `SETTINGS_STATE_FIELDS` |
| 能力表 | `SETTINGS_DATA_COVERAGE` 标 `excluded`（桌面偏好，不是 Enso capability） |
| 迁移 | 缺字段 = false，不必为加布尔值单独升 `SETTINGS_VERSION` |

开关只影响之后的 spawn，与 `exploreFoldEnabled` 相同。

## Worker / protocol

`AgentCommand.spawn-parent` 增加可选 `smartCompactEnabled?: boolean`。

链路（缺一即断）：

1. `agentHost` 从 `readSettingsState().smartCompactEnabled === true` 写入命令
2. `parseAgentCommand` 白名单 + `typeof === 'boolean'`
3. `supervisor.spawn` → `createSessionResourceLoader({ smartCompactEnabled })`

子会话工厂不传该标志。

## Loading the extension

`DefaultResourceLoader` 已支持 `additionalExtensionPaths` / `extensionFactories`（explore-fold 用 factory）。

打开时：

- Enso 把 `pi-smart-compact` 当普通 npm 依赖装进应用，**只用它的扩展入口**，不抄 EESV / loops / graph
- `additionalExtensionPaths` = `require.resolve('pi-smart-compact')`
- 解析失败 → 不传路径，会话照常建立，compact 走原生

`noExtensions: true` 的 loader（子代理 / Enso locked）即使误传路径也不该加载；实现上直接不传。

## Safe package defaults

扩展读自己的 `smartCompact` 配置（实现上落在 `~/.pi/agent/settings.json`，**不是** Enso `agentDir`，除非后续改包或设 HOME）。

Enso 在启用时 **merge** 下列键，只改 `smartCompact` 对象：

- `requireApproval: false` — 桌面没有它的 TUI 审批，默认 true 会卡住 apply
- `contextGraphEnabled: false` — 本期不做图谱 / recall 工具
- `agentToolAccess: "disabled"` — 不把 `smart_compact` / recall / save 暴露给模型
- `autoTrigger: true`
- `autoTriggerStrategy: "native-hook"`
- `showStatus: false` — 少打扩展 notify
- `mode: "auto"` — 由压力选 Fast/Balanced/Thorough，不默认 thorough

合并必须：读 JSON → 只覆盖以上键 → 原子写。其它顶层键（用户 Pi CLI 设置）不动。

路径：扩展 `settingsFile()` = `$HOME/.pi/agent/settings.json`。在 design 里承认与 Enso `userData/agent/pi-agent` 不一致；本期按包现状合并 HOME 下文件，避免改第三方包。若文件不存在则创建最小 `{ smartCompact: {...} }`。

## UI / i18n

- 标题：`Verified smart compaction`
- 说明：长会话用可验证摘要保留文件、错误和未完成项；失败回退默认压缩；可能更慢、多用 token。新会话生效。
- `/compact` 文案不改；不增加 slash command。

## Explicitly out

- `/smart-compact` 预检 TUI、loops 管理器、restore/metrics dashboard
- context graph、`smart_recall`、`smart_save_memory`
- 运行中会话热加载/卸载扩展
- 自己实现 EESV 或绕过 `session.compact()`

## Risks

| 风险 | 处理 |
| --- | --- |
| `node:sqlite` / Electron Node | 图谱关闭仍可能在 import 时加载；加载失败则不加路径 |
| 扩展注册 `/smart-compact` | 若 Enso 把扩展命令露进 slash 列表，可接受为隐藏能力；不在 UI 宣传 |
| HOME 配置污染 CLI Pi | 只 merge `smartCompact` 安全键 |
| 验证失败像「按了没反应」 | 扩展会回退原生；不改 compact 按钮状态机 |
| 多一次/几次 LLM | 文案写明；默认 auto 而非 thorough |

## Test surface (TDD)

可单测：

- `parseAgentCommand`：有/无 `smartCompactEnabled`、非布尔拒绝
- 纯函数：`resolveSmartCompactExtensionPath()`（找不到包 → undefined）
- 纯函数：`mergeSmartCompactSettings(existing, ensoDefaults)` 只改目标键

不测：设置页 React、真实 EESV、Electron 窗口。

协议 + 两个小纯函数，用例少，**inline Red-Green**，不拉 tester coworker。
