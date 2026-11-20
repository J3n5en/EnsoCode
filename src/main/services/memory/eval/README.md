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
2. 写入背景库 `BACKGROUND_MEMORIES`（38 条，跨 global / 当前项目 / 另一个项目）+ 用例自己的记忆。写入用 `force: true`，绕开去重候选网，保证构造的干扰项都真的落库；有 `entities` 的记忆直接写实体层，模拟 KG 抽取已完成；
3. 按 agent 检索（`bridge.ts`）同参调用：`mode: 'fast'`、`mmr: true`、`limit: 10`、固定 `now = 2025-11-20T10:00+08:00`；
4. 有 `unitType` 的用例在结果上后过滤——`searchMemories` 没有类型参数，这与管理页语义模式（`memoryAdmin.ts`）的做法一致；
5. 用 key → id 映射算指标，销毁临时库。

写入时刻缺省按顺序每条 +1 分钟，排序平局由 `updated_at` 决定，结果可复现。

## 指标

均为按用例的宏平均。

- **Recall@k**：期望项出现在前 k 名的比例。一次检索取 10 条，Recall@5 看其前 5 名。
- **MRR**：第一个期望项名次的倒数；没返回记 0。
- **噪声率**：返回结果里属于「期望排除项」的比例（排除项数 / 返回条数）。只在定义了排除项的用例上平均。

注意：向量通道不按余弦截断（#168），有 embedder 时几乎每次都返回满 10 条，所以噪声率衡量的是「排除项能不能被压出前 10」，不是「有没有阈值把它们挡掉」。

## 两种 embedder

**stub**（缺省，进 CI）：英文按词、中文按相邻二字哈希进 4096 维计数向量。确定性、零依赖、毫秒级。

- 能测：精确关键词、实体通道、时间过滤参数、类型后过滤、space 隔离、字面相近干扰项的排序——这些靠 FTS / 实体 / SQL 过滤，与 embedding 质量关系不大。
- **不能测语义**：它只编码字面重合，不懂同义词，也不跨语言。semantic、crossLingual 两维在 stub 下是 0，这是 stub 的能力边界，不是检索的真实水平。baseline 断言也不覆盖这两维。
- 它的向量通道相当于「第二个字面通道」，与生产模型的排序信号不同，stub 下的数字不能直接当作线上效果。

**real**（手动）：与生产同一条构造路径（`createEmbeddingProvider` → `toEmbedder`）。语义、跨语言只能在这里看。数字依赖模型文件和本机，不进 CI。

## Baseline（首次实跑）

### stub（CI 断言基准）

| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 |
|---|---|---|---|---|---|
| **overall** | 16 | 0.688 | 0.688 | 0.625 | 0.029 |
| exact | 2 | 1.000 | 1.000 | 1.000 | — |
| semantic | 2 | 0.000 | 0.000 | 0.000 | 0.050 |
| crossLingual | 2 | 0.000 | 0.000 | 0.000 | 0.000 |
| temporal | 2 | 1.000 | 1.000 | 1.000 | 0.050 |
| entity | 2 | 1.000 | 1.000 | 1.000 | 0.000 |
| typeFilter | 2 | 0.500 | 0.500 | 0.250 | 0.000 |
| spaceIsolation | 2 | 1.000 | 1.000 | 1.000 | 0.000 |
| distractor | 2 | 1.000 | 1.000 | 0.750 | 0.100 |

### real：local:potion-multilingual-128M（生产默认）

| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 |
|---|---|---|---|---|---|
| **overall** | 16 | 0.875 | 0.938 | 0.834 | 0.057 |
| exact | 2 | 1.000 | 1.000 | 1.000 | — |
| semantic | 2 | 0.500 | 1.000 | 0.550 | 0.050 |
| crossLingual | 2 | 0.500 | 0.500 | 0.500 | 0.050 |
| temporal | 2 | 1.000 | 1.000 | 1.000 | 0.050 |
| entity | 2 | 1.000 | 1.000 | 1.000 | 0.050 |
| typeFilter | 2 | 1.000 | 1.000 | 1.000 | 0.000 |
| spaceIsolation | 2 | 1.000 | 1.000 | 1.000 | 0.000 |
| distractor | 2 | 1.000 | 1.000 | 0.625 | 0.200 |

### real：local:qwen3-0.6b-gguf

| 范围 | 用例数 | Recall@5 | Recall@10 | MRR | 噪声率 |
|---|---|---|---|---|---|
| **overall** | 16 | 1.000 | 1.000 | 0.922 | 0.064 |
| exact | 2 | 1.000 | 1.000 | 1.000 | — |
| semantic | 2 | 1.000 | 1.000 | 0.750 | 0.100 |
| crossLingual | 2 | 1.000 | 1.000 | 1.000 | 0.050 |
| temporal | 2 | 1.000 | 1.000 | 1.000 | 0.050 |
| entity | 2 | 1.000 | 1.000 | 1.000 | 0.050 |
| typeFilter | 2 | 1.000 | 1.000 | 1.000 | 0.000 |
| spaceIsolation | 2 | 1.000 | 1.000 | 1.000 | 0.000 |
| distractor | 2 | 1.000 | 1.000 | 0.625 | 0.200 |

用例只有 16 条，每维 2 条，一条用例名次变化就会让维度指标跳 0.25–0.5；看趋势时以 overall 和逐条名次为准（`formatReport` 会输出逐条表）。

## 加用例

在 `cases.ts` 的 `EVAL_CASES` 里加一项：

- `memories`：本用例的记忆，`key` 在用例内（含背景库）唯一；可带 `unitType`、`eventStart/eventEnd`、`createdAt`、`entities`；
- `query` / `spaces`：查询串与参与检索的 space；`eventDateFrom/To` 模拟模型显式传的时间参数；`unitType` 表示只要某类型；
- `expected`：应命中的 key；`excluded`：语义相近但不该出现的 key。背景库记忆两者都不是。

原则：贴近真实使用（中文技术语境、项目记忆、偏好记忆），不要为了好测去掉干扰项；新增的背景记忆要确认不会成为任何已有用例的正确答案。加完用例 stub 数字会变，按新的实跑值更新 `baseline.test.ts` 和本文件，并在 PR 里说明。
