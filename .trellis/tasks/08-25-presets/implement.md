# Implement: 预设

## 执行清单（按序）

### 1. 数据模型与 main 解析
- [x] `assets.ts`：Preset + DEFAULT_PRESET_ID
- [x] `agent.ts`：AgentSpawnRequest.presetId?
- [x] `agentHost.ts`：resolvePreset —— 默认/缺省走 enabled 过滤（现逻辑），
      自定义按 id 集合过滤；指令注入改为按解析结果调 syncGlobalInstruction(instructionId?)
- [x] `instructionStore.ts`：syncGlobalInstruction 支持显式 instructionId
- 验证：typecheck

### 2. settings store + 设置页
- [x] settings store：presets + addPreset/updatePreset/removePreset
- [x] PresetsSettings.tsx：列表 + 新建/编辑 Dialog（skill 多选/MCP 多选/指令单选）
- [x] SettingsContent 注册分类；i18n 文案
- 验证：typecheck + lint

### 3. 会话侧
- [x] sessions store：Conversation.presetId + setPreset；send/resume 传 presetId
- [x] PresetPicker.tsx + ChatView 挂到 ModelPicker 左侧
- 验证：typecheck + lint + test

### 4. 真机验证（CDP）
- [x] 新建测试预设（1 skill + 0 MCP + 1 指令）
- [x] 新会话选它 spawn → commands 仅含该 skill、无 mcp 工具、AGENTS.md 为所选内容
- [x] 默认预设会话行为与现状一致
- [x] 删除被引用预设 → 回落默认
- [x] 清理测试预设/会话/文件

### 5. 收尾
- [x] 全量校验；小步提交；恢复用户设置数据
