# Design: 预设

## 数据流

```
settings store（renderer, persist 到 settings.json）
  presets: Preset[]           ← 设置页编辑（默认预设不入库，运行时合成）
conversation.presetId?        ← Composer 选择器，per 会话记忆
  └─ spawn request 带 presetId
       └─ main agentHost：resolvePreset(presetId) → skillPaths / mcpServers / instruction
```

## 关键决策

1. **默认预设不入库**：`DEFAULT_PRESET_ID = 'default'` 常量，renderer/ main 各自合成
   （语义 = enabled 过滤即现行为）。避免持久化一份要迁移的内建数据。
2. **过滤语义**：自定义预设按 id 显式集合过滤，忽略条目自身 enabled——预设即边界；
   默认预设走 enabled。指令文件：自定义预设直接注入其 instructionId（无视 enabled/互斥），
   默认预设走现有单主源 enabled。
3. **失效引用**：resolve 时 id 找不到就跳过（条目已删）；presetId 找不到回落默认。
4. **不热切换**：切换预设只写 conversation.presetId，已 spawn 会话下次 resume/新会话生效。
   ModelPicker 的 reasoning 同款「静默存储」模式，无需重开提示（成本低收益小）。

## 文件改动

| 文件 | 改动 |
|---|---|
| `src/shared/types/assets.ts` | `Preset` 接口 + `DEFAULT_PRESET_ID` |
| `src/renderer/stores/settings/index.ts` | `presets` 状态 + add/update/remove |
| `src/renderer/components/settings/PresetsSettings.tsx`（新） | 列表 + 新建/编辑对话框（skill 多选/MCP 多选/指令单选） |
| `src/renderer/components/settings/SettingsContent.tsx` | 注册「预设」分类 |
| `src/renderer/components/chat/PresetPicker.tsx`（新） | Composer pill 选择器 |
| `src/renderer/components/chat/ChatView.tsx` | toolbar 里 ModelPicker 左侧挂 PresetPicker；conversation.presetId 读写 |
| `src/renderer/stores/sessions/index.ts` | Conversation.presetId + setPreset；send/resume 传 presetId |
| `src/shared/types/agent.ts` | AgentSpawnRequest + spawn 命令带 presetId?（仅 request→main，worker 不感知 preset，仍收解析后的 skillPaths/mcpServers） |
| `src/main/services/agentHost.ts` | `resolvePreset(presetId)` 替换 enabledSkillPaths/enabledMcpServers/syncGlobalInstruction 的取值逻辑 |
| `src/main/services/instructionStore.ts` | syncGlobalInstruction 接受指定 instructionId 参数 |
| `src/shared/i18n.ts` | 文案 |

## UI 形状

- 设置页：卡片列表；默认预设置顶带「默认」徽标、无操作按钮;自定义带编辑/删除
- 编辑对话框：名称输入 + 三段勾选列表（沿用现有 Checkbox/Dialog 组件）
- PresetPicker：pill 显示当前预设名（默认显示「默认」），点开下拉列表打勾选择
