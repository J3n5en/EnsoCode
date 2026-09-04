# Custom model unit prices for usage

## Goal

用量页可以按用户自己填的单价估算费用。Catalog 对不上（`qwen-3.8-27b`）或全零（`gemini-3.8-flash-tiered`）时不再漏计；中转价和 catalog 不一致时也能盖过去。

## Confirmed facts

- 用量费用来自 `runtime.getModels()` 的 catalog `cost`（$/M tokens），不是账单接口。
- `toPricing` 把四项全零当未定价；`costOf` 精确 id 优先，否则剥思考档位后缀再查。
- `qwen-3.8-27b` 不在 pi-ai catalog；`gemini-3.8-flash-tiered` 在 Antigravity 写 `ZERO_COST`。
- 用量页只读；设置走 zustand `enso-settings` + `SETTINGS_STATE_FIELDS`；主进程读 settings 已有 `loadUsageProjectAliases`。
- 新 settings 字段可缺省为 `{}`，不必为加字段单独升 `SETTINGS_VERSION`（现有 persist 类型演进惯例）。
- catalog 单价表有 10 分钟缓存；覆盖必须在每次 `getUsageSummary` 时叠上去，不能等 TTL。
- 定价合并与校验是可单测纯逻辑，必须 TDD。

## Requirements

- 用户能按 **精确 model id** 保存一组单价：`input` / `output` / `cacheRead` / `cacheWrite`，单位 $/M tokens。
- 一条覆盖必须四项齐全；缺项按 0。有覆盖时整组替换 catalog，不做半覆盖继承。
- 自定义四项全零视为用户定价 $0.00（与 catalog 全零=未定价不同）。
- 入口在用量页底部独立「单价」区：列出已保存覆盖；可手填任意精确 id（不必出现在当前周期）；可删除恢复 catalog。
- 保存或删除后刷新本页用量；该 id 按覆盖计入费用，未定价提示随之更新。
- 旧 settings 无此字段时只靠 catalog。
- 无效 id / 非有限非负数字不得落盘，不得显示误导性 $0.00。

## Acceptance Criteria

- [ ] 为 `qwen-3.8-27b` 保存四项单价后，该模型用量行与总计按覆盖估算，不再出现在「无目录单价」列表。
- [ ] 为已有 catalog 价的模型保存覆盖后，估算用覆盖而不是 catalog。
- [ ] 删除覆盖后恢复 catalog 行为（未定价则再次显示 —）。
- [ ] 手填当前周期未出现的精确 id 可以保存；以后该 id 出现即按覆盖计费。
- [ ] 四项全零的覆盖计为 $0.00，不进未定价列表。
- [ ] 空 id、负值、NaN 不能保存。
- [ ] 无覆盖字段的旧 settings 与现在一致。
- [ ] 保存覆盖后立即刷新用量，不等 catalog 10 分钟缓存。
- [ ] `pnpm typecheck && pnpm test` 绿；Biome 对改动文件干净。

## Out of scope

- 不拉供应商实时牌价。
- 不做 id 别名映射（`qwen-3.8-27b` ↛ `qwen/qwen3.8-27b`）。
- 不改会话账本 token 数。
- 不做导入/导出价目表、按 provider 批量定价。
- 不改模型排行表行内编辑。
- 不改聊天状态栏 / 订阅额度（`useAccountUsage`）。

## Decisions

- 允许覆盖 catalog 已有单价。
- 编辑入口：用量页底部独立「单价」区。
- 一条覆盖必须四项齐全；缺项按 0。
- 允许手填任意精确 id。
