# 记忆 / 规则 / Skills：oh-my-pi vs EnsoCode

来源：coworker `omp-memory`。

## 对方有而我们没有

### 三后端记忆
- `local`：两阶段萃取 → MEMORY.md / learned.md / skills
- `hindsight`：远程向量，每 3 轮批量写
- `mnemopi`：本地 SQLite，向量+图+事实+时间 RRF
- 工具：retain / recall / reflect / memory_edit / learn
- 我们：`contextOccupancy` 里 `projectMemoryText` 占位。
- **先抄 local 两阶段。** 路径：`memory-backend/`、`memories/`、`packages/mnemopi/`

### 八级规则发现 + 三桶
- native / plugins / agents / cursor / windsurf / cline / github applyTo / builtin
- TTSR 桶 / alwaysApply 全文 / rulebook 只注索引 + `rule://`
- 我们：导入弹窗深拷贝 + `harnessAssets` 扁平拼进 prompt。
- **先抄运行时发现 + rulebook。** 路径：`discovery/`、`capability/rule-buckets.ts`

### TTSR（同 session 笔记）
- 流式掐断、discard、afterToolCall reminder。

### 上下文文件
- 多层 AGENTS/CLAUDE/GEMINI + `@` 递归展开 5 层 + sticky RULES.md

### Skills + marketplace
- `skill://`、兼容 Claude marketplace、`/skill:name`
- 我们：`.agents/skills` + settings 导入，无虚拟协议/市场

### Snapcompact / Autolearn / Autoresearch
- 历史渲点阵图；工具次数超阈值后台沉淀 skill；固定跑分 keep/discard。
- Snapcompact **可观望/黑科技**；Autoresearch 场景窄。

## 双方都有

- 都读项目内规则文件；我们是副本，对方是每次原生扫描。

## 我们更强

- Trellis spec/task 工程纪律（对方无对等产品层）
- 导入器对「用户想迁配置进 Enso」仍有价值，只是不该当唯一路径

## Top 5

1. 多 harness 运行时发现  
2. Rulebook + `rule://`  
3. TTSR  
4. Local 两阶段记忆  
5. Snapcompact  
