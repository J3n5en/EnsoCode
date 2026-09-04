# 实施计划

1. 测试先行：在 `src/main/services/usage/usageService.test.ts` 增加本地补充价格测试，覆盖促销期、标准期和上游价格优先。
2. 测试先行：在 `src/shared/providers/antigravity.test.ts` 增加 3.8 逻辑模型的 wire ID 路由与动态清单归一测试。
3. 测试先行：在 `src/shared/usage/aggregate.test.ts` 增加零 token 未定价记录不进入警告、真实未知模型仍告警的测试。
4. 运行三个相关测试文件，确认因功能缺失出现断言失败。
5. 在 `usageService.ts` 实现按日期生效、上游优先的本地价格补充，并接入 `getPricingTable()`。
6. 在 `antigravity.ts` 添加 `gemini-3.8-flash` 逻辑模型和 low/medium/high wire 路由。
7. 在 `aggregate.ts` 将无价格警告限定为 token 大于 0 的记录。
8. 运行相关测试确认 Green。
9. 运行 `pnpm typecheck`、修改文件 Biome 检查和 `pnpm test`。
10. 启动开发版，经 CDP 验证设置页用量摘要不再把 `gemini-3.8-flash-high` 与零 token `imported` 标成无目录单价。

## 风险与回滚点

- 日期边界必须使用 UTC 且可注入时间测试，避免本地时区造成提前或延后切价。
- 本地价格不得覆盖未来上游目录价格。
- 3.8 wire 映射只认已确认的 low/medium/high；tiered 不归并。
- imported 修复不能吞掉真实有 token 的未知模型告警。
