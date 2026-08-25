# PRD: 预设（skill / MCP / 指令文件组合）

## 背景

设置里的 skill / MCP / 指令文件注入目前是全局 enabled 开关——所有会话共享同一套。
不同任务需要不同组合（如「逆向分析」要 camoufox 但不要 cloudflare skills），
每次去设置里翻开关不现实。引入**预设**：一份命名的注入组合，会话级选用。

## 需求

### 1. 数据模型
- `Preset { id, name, builtin, skillIds: string[], mcpServerIds: string[], instructionId?: string }`
- **默认预设**：内建、只读、不可删除/改名/编辑，语义 = **跟随设置页各条目的 enabled 状态**
  （即现行为；设置页开关仍是全局默认的编辑入口）
- 自定义预设：显式勾选 skill 集合、MCP server 集合、指令文件（单选，沿用单主源）；
  引用按 id，条目被删除时预设内失效引用静默忽略

### 2. 设置页「预设」
- 新增分类页，列出默认 + 自定义预设
- 默认预设显示为只读（无编辑/删除按钮，标注「默认」）
- 新建/编辑对话框：名称 + skill 多选 + MCP 多选 + 指令文件单选（可不选）
- 可删除自定义预设（被会话引用的删除后，会话回落默认预设）

### 3. Composer 预设选择器
- 位于模型选择器**左边**，同款 pill 风格
- 列出全部预设，当前选中打勾；默认选中「默认预设」
- per 会话记忆（像 reasoningEnabled）；**下次 spawn 生效**（已 spawn 会话切换预设
  提示或静默存储均可——本期不做运行中热切换）

### 4. spawn 链路
- spawn request 带 `presetId?`；main 侧解析：
  - 无 presetId / 默认预设 → 现行为（enabled 过滤）
  - 自定义预设 → 按预设的 id 集合过滤（**且条目自身 enabled 不再参与过滤**，
    预设显式选择即生效边界）
  - 指令文件：预设指定的那份注入；未指定 → 不注入

## 非目标
- 运行中会话热切换预设
- 预设含 provider/model/推理档位（只管注入三件套）
- 预设导入导出

## 验收
1. 默认预设只读；新建「测试预设」仅勾 1 个 skill + 0 MCP + 1 指令文件
2. 会话 A 选测试预设 → spawn 后仅含该 skill 的 `/skill:` 命令、无 MCP 工具、
   agentDir/AGENTS.md 为所选指令内容
3. 会话 B 用默认预设 → 现行为不变
4. 删除被引用预设 → 会话回落默认，不报错
5. `pnpm typecheck && pnpm lint && pnpm test` 全绿；真机 CDP 验证后清理测试数据
