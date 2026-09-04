# 技术设计

## 边界

本次只修正本地目录派生与展示归一，不改上游 npm 包、不新增 IPC、不改变会话文件格式。

## 数据流

1. 用量价格：`runtime.getModels()` → `buildPricingTable()` → 本地官方价格补充 → `resolvePricing()` → `aggregateUsage()`。
2. Antigravity：联网发现 wire ID → `mergeAntigravityModels()` 认领为逻辑模型 → 用户选择逻辑 ID → `resolveAntigravityWireModelId()` 按思考档位发真实 wire ID。
3. 无价格提示：`UsageRecord` → `tokensOf()` / `costOf()` → `unpricedModels`。

## 设计决策

### 1. 本地价格补充

- 在 `src/main/services/usage/usageService.ts` 增加纯函数，用本地补充价格填充上游目录缺失项。
- 上游目录存在同 ID 时必须优先，不允许本地补充覆盖上游更新。
- `gemini-3.8-flash` 在 2027-01-01 UTC 前使用初次体验价：input 0.75、output 3.75、cacheRead 0.075、cacheWrite 0，单位均为美元/百万 token。
- 2027-01-01 UTC 起使用标准价：input 1.5、output 7.5、cacheRead 0.15、cacheWrite 0。
- Google 的缓存存储按 token/小时计费，当前 `ModelPricing.cacheWrite` 不是存储时长模型，因此沿用现有 Google 目录约定设为 0，不伪造不可表达的费用。

### 2. Antigravity 3.8 逻辑模型

- 脚本生成的逻辑模型表保持独立，`gemini-3.8-flash` 放入项目本地补充表，避免下次整段生成覆盖。
- 按任务调查记录的私有模型清单映射：low → `gemini-3.8-flash-low`、medium → `gemini-3.8-flash-medium`、high → `gemini-3.8-flash-high`；这些不是公网官方模型 ID。
- `thinkingLevelMap` 明确将 `minimal` 标为不支持；若历史配置仍传入 minimal，最终请求会同时钳位为 low wire 与 `LOW` thinking level。
- `gemini-3.8-flash-tiered` 保持独立动态条目，本次不推测其与标准思考档的语义关系。

### 3. imported 噪声

- 不删除用量记录、不改 totals、按模型行或会话计数。
- 仅当无价格记录的 token 数大于 0 时才加入 `unpricedModels`。
- 因此 `imported` 的零 token 行仍可追溯，但不会被误报为缺价格；真实有 token 的未知模型仍继续告警。

## 兼容与回滚

- 无持久化迁移。
- 删除本地价格补充即可回退到上游目录行为。
- 删除 3.8 逻辑条目后，动态发现的 wire ID 会恢复原样暴露。
- 恢复 `unpriced.add` 原条件即可恢复旧提示行为。
