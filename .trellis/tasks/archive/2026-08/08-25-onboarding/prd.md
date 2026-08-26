# PRD: 首次运行 onboarding 引导

## 背景

新用户首次打开 enso-code 时面对空界面，不知道要先去设置里导入 provider 才能对话。
四类可配置项（provider / skill / MCP / 指令文件）都已有从本地 AI 应用扫描导入的能力，
但入口埋在设置各分页里。首次运行用一个引导把它们串起来。

## 需求

1. **首次运行判定**：settings 里加持久化标志 `onboarded: boolean`（默认 false）。
   为 false 时 app 启动后弹出 onboarding，完成或关闭后置 true，之后不再弹。
2. **多步向导**（模态覆盖主界面）：
   - 欢迎页（一句话介绍 + 开始）
   - Provider 导入（复用现有 provider 导入流程）
   - Skill 导入（复用）
   - MCP 导入（复用）
   - 指令文件导入（复用）
   - 完成页
3. **交互**：
   - **允许直接关闭**（右上角 ×，任意步都可关，置 onboarded=true）
   - **允许直接下一步**（不导入也能跳过每步）
   - 上一步 / 下一步 / 跳过 导航；最后一步「完成」
   - 步骤进度指示（第 N/几步）
4. 每步内嵌对应的扫描+导入 UI（不是跳转到设置页）；导入结果直接进 settings store

## 非目标
- 不做账号登录 / 云同步
- 不新增导入逻辑（完全复用现有 scan/import）
- 不强制任何一步必须导入

## 验收
1. 全新状态（onboarded=false / settings 为空）启动 → 自动弹 onboarding
2. 走完各步能导入 provider/skill/mcp/指令，导入项出现在设置里
3. 任意步点 × 关闭 → 不再弹；「完成」→ 不再弹
4. 已 onboarded 再启动 → 不弹
5. `pnpm typecheck && lint && test` 全绿；真机 CDP 验证首次弹出 + 关闭后不再弹，之后清理测试状态
