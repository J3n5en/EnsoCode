# Design — custom usage unit prices

## Behavior gap

现在：费用只看 catalog；对不上或全零 → `cost = null`。  
目标：settings 里按精确 model id 存覆盖，汇总时整组替换 catalog。

行为住在 `getUsageSummary` → `buildPricingTable` / `costOf`，不是 renderer 事后改数字。

## Data

`usageModelPricing: Record<string, ModelPricing>` 进 `enso-settings`。

- key = 精确 model id（trim，非空）
- value = `{ input, output, cacheRead, cacheWrite }`，有限且 ≥ 0
- 缺字段 / 非法条目读取时丢弃该条，其余保留
- 新字段默认 `{}`，不升 `SETTINGS_VERSION`

## Merge

`mergePricingTable(catalog, overrides)`（shared 纯函数）：

1. 从 catalog 建表现有规则不变（全零仍当未定价）
2. 合法覆盖按精确 id 整组写入（可写全零）
3. `costOf` 仍先精确再剥思考后缀；覆盖只绑精确 id

主进程每次 `getUsageSummary` 读 settings 覆盖再 merge，不跟 catalog 10 分钟缓存绑死。

## Persistence / layers

```
UsageSettings 单价区
  → useSettingsStore.usageModelPricing + set/remove
  → persist 白名单 SETTINGS_STATE_FIELDS
  → getUsageSummary 读 settings 覆盖 merge → aggregateUsage
```

不新增 IPC。无主题类副作用，不必进 `applySettings()`。

## UI

用量页底部「单价」：已保存行（四项 + 删除）+ 新增（id + 四项）。保存后 `load(days)`。文案走 `t()` + `i18n.ts`。

## Compatibility / rollback

旧数据无字段 = 空覆盖。删字段或回退代码后只丢估算覆盖，账本不动。
