# Implement — custom usage unit prices

TDD：先 shared 合并/校验（inline Red-Green），再 store/IPC 白名单，最后用量页。

## Checklist

1. `src/shared/usage/pricing.ts`：`parseUsageModelPricing` + `mergePricingTable`；先写 `pricing.test.ts`。
2. settings：`types.ts` / `initialState` / action；`SETTINGS_STATE_FIELDS` 加 `usageModelPricing`。
3. `usageService.getUsageSummary`：读 settings 覆盖后 merge；补 `usageService.test.ts`。
4. `UsageSettings` 底部单价区 + `i18n.ts`；保存/删除后刷新 summary。
5. `pnpm typecheck && pnpm test`；改动文件 `biome check`。

## Validation

- 覆盖盖 catalog；删覆盖回 catalog；全零覆盖 = $0 且不进 unpriced。
- 坏数据不落盘；无字段旧 settings 行为不变。
- 保存后立即反映，不等 catalog TTL。

## Rollback

- 单价合并是独立提交。
- settings 字段 + 白名单是独立提交。
- UI 独立提交；回退 UI 后覆盖数据仍在，只是不能改。
