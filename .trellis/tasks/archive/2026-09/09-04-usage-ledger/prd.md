# Usage ledger

删会话后用量仍在。每轮终态增量写入账本；fork 前缀与 rewind 已发生的 token 不重复计、不丢。

## Rules

- 记录主键：jsonl entry `id`（全局去重）。fork 复制同一 id 只计一次。
- rewind 已产生的调用保留（钱已经花了）；新轮新 id 另计。
- live jsonl 仍在则以 live 为准覆盖同 id；jsonl 没了用账本。
- 删除会话不删 `usage-ledger/`。
- 费用仍现算，账本只存 token。
