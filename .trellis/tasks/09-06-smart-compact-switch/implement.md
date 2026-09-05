# Implement

## Checklist

1. **RED 协议**  
   `src/shared/types/agent.test.ts`：`spawn-parent` 带 `smartCompactEnabled: true` 通过；非布尔 / 未知键仍拒绝。

2. **GREEN 协议**  
   `AgentCommand` 类型 + `parseAgentCommand` 白名单与布尔校验。

3. **RED 纯函数**  
   新 `src/agent/smartCompact.test.ts`：  
   - 包入口可解析时返回路径，不可解析返回 undefined  
   - merge 不删除其它顶层键，只补/覆盖 Enso 安全默认

4. **GREEN 纯函数**  
   `src/agent/smartCompact.ts`：`resolveSmartCompactExtensionPath`、`mergeSmartCompactSettings`、`ENSO_SMART_COMPACT_CONFIG`。

5. **接线 worker**  
   `createSessionResourceLoader` 在 `smartCompactEnabled` 且解析到路径时设 `additionalExtensionPaths`。  
   spawn 启用时对扩展 settings 文件做一次 merge（失败只 warn）。  
   `agentHost` 读设置写入 `spawn-parent`。

6. **设置层**  
   types / initialState / setter / `SETTINGS_STATE_FIELDS` / capability coverage / `SmartCompactPicker`（开关 + 模型）/ i18n 中英。

7. **依赖**  
   `pnpm add pi-smart-compact`（与当前 `@earendil-works/pi-coding-agent` 对齐）。

8. **验证**  
   `pnpm exec vitest run src/shared/types/agent.test.ts src/agent/smartCompact.test.ts`  
   再 `pnpm typecheck && pnpm test` 与 `biome check` 针对改动文件。

## Rollback

关开关即不再加载扩展。去掉字段后旧会话不受影响。`settings.json` 里多一个无害布尔。

## Review gates

- 子会话 loader 无 smart-compact 路径  
- 未解析到包时 spawn 不抛  
- 不引入 `/smart-compact` UI、图谱工具
