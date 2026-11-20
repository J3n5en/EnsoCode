# 记忆检索评测

只评测检索层：`searchMemories` 在给定记忆库、查询下的排序质量。不覆盖提炼（distill）、去重、KG 抽取。

## 怎么跑

```bash
# CI 同款：stub embedder，断言不低于 baseline
pnpm vitest run src/main/services/memory/eval

# 同上，并打印 stub 的 Markdown 报告
ENSO_MEMORY_EVAL=stub pnpm vitest run src/main/services/memory/eval

# 手动：真实 embedding 模型，打印报告（不做阈值断言）
ENSO_MEMORY_EVAL=real pnpm vitest run src/main/services/memory/eval
ENSO_MEMORY_EVAL=real ENSO_MEMORY_EVAL_MODEL=local:qwen3-0.6b-gguf pnpm vitest run src/main/services/memory/eval
```

real 模式的环境变量：

| 变量 | 含义 | 缺省 |
|---|---|---|
| `ENSO_MEMORY_EVAL_MODEL` | embedding registry id | `local:potion-multilingual-128M`（生产默认） |
| `ENSO_MEMORY_EVAL_MODEL_DIR` | 模型文件目录 | 应用 userData 下 `memory/models/<id>`（需先在设置页下载过） |
| `ENSO_MEMORY_EVAL_REMOTE_BASE_URL` / `_API_KEY` | `remote:<model>` 用的 OpenAI 兼容端点 | — |

程序化调用：`runEvalWith('stub' | 'real')` 或 `runEval({ embedder, label })`，`formatReport(report)` 出 Markdown。

## 每条用例怎么跑

1. 新建临时 SQLite 库（与生产同一 `openMemoryDb`，加载 sqlite-vec）；
2. 写入背景库 `BACKGROUND_MEMORIES`（85 条：global 28 / 当前项目 46 / 另一个项目 11）+ 用例自己的记忆。写入用 `force: true`，绕开去重候选网，保证构造的干扰项都真的落库；有 `entities` 的记忆直接写实体层，模拟 KG 抽取已完成；有 `evolves` 的记忆走 `createMemory` 的 `evolvesFromId / evolvesRelation` 写关系（`replaces` 让旧行退出 `is_latest`，`challenges` 不动旧行）；
3. 按 agent 检索（`bridge.ts`）同参调用：`mode: 'fast'`、`mmr: true`、`limit: 10`、固定 `now = 2025-11-20T10:00+08:00`；
4. 有 `unitType` 的用例在结果上后过滤——`searchMemories` 没有类型参数，这与管理页语义模式（`memoryAdmin.ts`）的做法一致；
5. 用 key → id 映射算指标，销毁临时库。

写入时刻缺省按顺序每条 +1 分钟，排序平局由 `updated_at` 决定，结果可复现。同一次运行内按 (kind, 文本) 缓存向量（背景库每条用例都要重写一遍），已核对 potion 下有无缓存报告逐字一致。

## 指标

均为按用例的宏平均。

- **Recall@k**：期望项出现在前 k 名的比例。一次检索取 10 条，Recall@5 看其前 5 名。
- **MRR**：第一个期望项名次的倒数；没返回记 0。
- **噪声率**：返回结果里属于「期望排除项」的比例（排除项数 / 返回条数）。只在定义了排除项的用例上平均。
- **staleRate**：返回结果里属于「已过期记忆」（用例的 `stale`）的比例（过期项数 / 返回条数），只在 stale 维度上平均；过期项不计入噪声率。几乎总是返回满 10 条，所以一条过期项进前 10 就是 0.1——看这一维要同时看逐条表里过期项的名次，排在新记忆前面比单纯进榜更危险。

注意：向量通道不按余弦截断（#168），有 embedder 时几乎每次都返回满 10 条，所以噪声率衡量的是「排除项能不能被压出前 10」，不是「有没有阈值把它们挡掉」。

## 两种 embedder

**stub**（缺省，进 CI）：英文按词、中文按相邻二字哈希进 4096 维计数向量。确定性、零依赖、毫秒级。

- 能测：精确关键词、实体通道、时间过滤参数、类型后过滤、space 隔离、字面相近干扰项的排序——这些靠 FTS / 实体 / SQL 过滤，与 embedding 质量关系不大。
- **不能测语义**：它只编码字面重合，不懂同义词，也不跨语言。semantic、crossLingual 两维在 stub 下的非零值（各 0.333）全部来自字面重合的用例（保留原文的 worktree / codesign、恰好同词的改写），这是 stub 的能力边界，不是检索的真实水平。baseline 断言也不覆盖这两维。
- 它的向量通道相当于「第二个字面通道」，与生产模型的排序信号不同，stub 下的数字不能直接当作线上效果。

**real**（手动）：与生产同一条构造路径（`createEmbeddingProvider` → `toEmbedder`）。语义、跨语言只能在这里看。数字依赖模型文件和本机，不进 CI。

## Baseline

51 条用例（exact 5 / semantic 6 / crossLingual 6 / temporal 6 / entity 5 / typeFilter 6 / spaceIsolation 5 / distractor 6 / stale 6），背景库 85 条。三组均为本机实跑，逐条名次见 `formatReport` 的逐条表。

### stub（CI 断言基准）

| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 | staleRate |
|---|---|---|---|---|---|---|
| **overall** | 51 | 0.794 | 0.824 | 0.675 | 0.049 | 0.100 |
| exact | 5 | 1.000 | 1.000 | 1.000 | 0.000 | — |
| semantic | 6 | 0.333 | 0.333 | 0.125 | 0.050 | — |
| crossLingual | 6 | 0.333 | 0.333 | 0.333 | 0.000 | — |
| temporal | 6 | 1.000 | 1.000 | 0.806 | 0.050 | — |
| entity | 5 | 1.000 | 1.000 | 1.000 | 0.040 | — |
| typeFilter | 6 | 0.750 | 0.833 | 0.750 | 0.000 | — |
| spaceIsolation | 5 | 1.000 | 1.000 | 0.900 | 0.000 | — |
| distractor | 6 | 1.000 | 1.000 | 0.783 | 0.217 | — |
| stale | 6 | 0.833 | 1.000 | 0.528 | — | 0.100 |

### real：local:potion-multilingual-128M（生产默认）

| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 | staleRate |
|---|---|---|---|---|---|---|
| **overall** | 51 | 0.882 | 0.882 | 0.770 | 0.053 | 0.100 |
| exact | 5 | 1.000 | 1.000 | 1.000 | 0.033 | — |
| semantic | 6 | 0.333 | 0.333 | 0.125 | 0.033 | — |
| crossLingual | 6 | 0.667 | 0.667 | 0.667 | 0.017 | — |
| temporal | 6 | 1.000 | 1.000 | 1.000 | 0.050 | — |
| entity | 5 | 1.000 | 1.000 | 1.000 | 0.080 | — |
| typeFilter | 6 | 1.000 | 1.000 | 1.000 | 0.000 | — |
| spaceIsolation | 5 | 1.000 | 1.000 | 0.900 | 0.000 | — |
| distractor | 6 | 1.000 | 1.000 | 0.639 | 0.200 | — |
| stale | 6 | 1.000 | 1.000 | 0.700 | — | 0.100 |

### real：local:qwen3-0.6b-gguf

| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 | staleRate |
|---|---|---|---|---|---|---|
| **overall** | 51 | 1.000 | 1.000 | 0.873 | 0.079 | 0.100 |
| exact | 5 | 1.000 | 1.000 | 1.000 | 0.067 | — |
| semantic | 6 | 1.000 | 1.000 | 0.792 | 0.050 | — |
| crossLingual | 6 | 1.000 | 1.000 | 0.875 | 0.067 | — |
| temporal | 6 | 1.000 | 1.000 | 1.000 | 0.067 | — |
| entity | 5 | 1.000 | 1.000 | 1.000 | 0.100 | — |
| typeFilter | 6 | 1.000 | 1.000 | 1.000 | 0.000 | — |
| spaceIsolation | 5 | 1.000 | 1.000 | 0.900 | 0.000 | — |
| distractor | 6 | 1.000 | 1.000 | 0.617 | 0.267 | — |
| stale | 6 | 1.000 | 1.000 | 0.722 | — | 0.100 |

每维 5–6 条，一条用例名次变化让维度 MRR 跳约 0.03–0.2；比 16 条时（每维 2 条、跳 0.25–0.5）稳，但单维差 1 条用例仍不足以下结论，下面只写差距在多条用例上一致的观察。

## 观察：potion 在语义、跨语言上明显弱于 qwen3（扩样本后仍然存在）

16 条时 potion 在 semantic / crossLingual 的 Recall@5 各 0.5，只有 4 条用例，算不上证据。扩到每维 6 条后差距没有消失，反而更清楚：

| 维度（各 6 条） | potion Recall@10 | qwen3 Recall@10 | potion MRR | qwen3 MRR |
|---|---|---|---|---|
| semantic | 0.333（2/6 进前 10） | 1.000（6/6） | 0.125 | 0.792 |
| crossLingual | 0.667（4/6） | 1.000（6/6） | 0.667 | 0.875 |

- semantic：potion 漏掉 4 条（flaky-ci、action-rewrite、mixed-lang、symptom），命中的两条也只排在第 2、4 名；qwen3 全部进前 10，4 条排第 1。potion 的 semantic Recall@10 与 stub（纯字面哈希）同为 0.333，说明在「没有共同词的改写」上它几乎没有超出字面匹配。
- crossLingual：potion 漏掉的 2 条都是「中文查询找英文记忆、没有共同术语」（xlang-zh-to-en、xlang-image-memory）；命中的 4 条里 2 条靠保留原文的术语（worktree、codesign），2 条是英文查询找中文记忆。qwen3 6/6。
- 合计 12 条语义 / 跨语言用例：potion 6/12 进前 10，qwen3 12/12。差距由 6 条不同用例构成（semantic 4 + crossLingual 2），每条都是 potion 没进前 10、qwen3 进了，不是单条名次抖动。
- 其余维度两者持平（exact / temporal / entity / typeFilter / spaceIsolation 的 Recall 均为 1.000）；distractor 上 qwen3 噪声率更高（0.267 vs 0.200），因为它把语义相近的干扰项也拉进了前 10。

结论：生产默认模型 potion 的语义召回明显偏弱，换说法、中文查英文记忆基本只能靠字面 / 术语重合兜底。是否切换默认模型还要权衡体积与推理开销，不在本评测范围。

## 观察：过期记忆照样被召回（stale）

stale 维度 6 条，三组 embedder 的 staleRate 都是 0.100，且逐条结果高度一致：

- 6 条里 5 条的过期项进了前 10，只有显式 `replaces` 的那条（旧行 `is_latest = 0`）干净；
- 3 条（stale-path-moved、stale-api-signature、stale-multi-version）**过期项排在第 1 名、在新记忆之前**，三个 embedder 无一例外（stub 下 stale-config-pnpm 也是旧的排第 1）——旧记忆与查询字面更贴近（原样的文件名 / 调用写法 / 主题词），新记忆是「已改成…」的叙述，新近度（decay）权重不足以翻盘；stale-multi-version 里最早的 v1 排第 1，正确的 v3 在 stub / potion / qwen3 下分别排第 6 / 5 / 3；
- `challenges` 关系不影响检索：被反驳的旧决定仍是 `is_latest`，照常进前 10（stub / potion 第 6，qwen3 第 4）。

结论：除非写入时显式 `replaces`，检索层对「旧事实已被推翻」没有任何感知；没有关系的新旧并存和 `challenges` 都会把过期记忆交给模型，且经常排在最前。这是要报给 owner 的问题，不是用例难度问题。

## 加用例

在 `cases.ts` 的 `EVAL_CASES` 里加一项：

- `memories`：本用例的记忆，`key` 在用例内（含背景库）唯一；可带 `unitType`、`eventStart/eventEnd`、`createdAt`、`entities`、`evolves`（`{ from: 更早一条的 key, relation }`）；
- `query` / `spaces`：查询串与参与检索的 space；`eventDateFrom/To` 模拟模型显式传的时间参数；`unitType` 表示只要某类型；
- `expected`：应命中的 key；`excluded`：语义相近但不该出现的 key；`stale`：已被更晚记忆推翻的 key（算 staleRate，不算噪声）。背景库记忆三者都不是。

原则：贴近真实使用（中文技术语境、项目记忆、偏好记忆），不要为了好测去掉干扰项；新增的背景记忆要确认不会成为任何已有用例的正确答案。加完用例 stub 数字会变，按新的实跑值更新 `baseline.test.ts` 和本文件，并在 PR 里说明。
