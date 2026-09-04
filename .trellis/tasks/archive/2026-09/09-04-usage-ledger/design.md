# Design

- `UsageRecord.id` = jsonl 行 id
- `src/shared/usage/ledger.ts`: `mergeUsageSources(live, ledger)` 按 id 去重（live 覆盖），activity 只用「该 session 仍有留下的 record」所覆盖的 span
- 盘：`userData/agent/usage-ledger/<sessionId>.json`
- 每轮 `agent_end`（非 willRetry）和 `failTurn`（有 usage）upsert 该 session 快照（parse 当前 jsonl 或只追加末条）
- `getUsageSummary` = merge(loadSessions, loadLedger) → aggregate
