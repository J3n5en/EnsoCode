# memory_search 冷启动 / 默认范围连续 15s 超时

## 症状

装上新版（#381 后）首次 `memory_search` 连续报 `Memory action search timed out after 15000ms`；
几十秒后 `spaceId: project` 的检索 0.4s 返回，默认（`all`）检索仍要 11–13s。
工具超时后服务里的检索其实跑完了（`memories.last_hit_at` 有对应时间戳），只是回得太晚。

## 根因

两件事叠加，单看哪一件都会误判：

1. **实体通道查询计划二次方**：`spaceIds` 多于一个（默认 `all` = 项目 + global）时，
   SQLite 把 `entities` 排成外层（按 space_id）、`memories` 排成内层，变成「space 内全部实体 ×
   space 内全部记忆」的嵌套循环，每对都探一次 mentions 主键。用户库 1.16 万实体 × 2364 记忆
   单次 18.8s（better-sqlite3 实测），单 space 只要 40ms。同步 SQL 占住服务线程，并发检索排队。
   合成数据要按真实分布造（每个实体至少一条 mention、各 space 的记忆交错写入），否则孤儿实体
   开库即被清掉、行局部性过好，复现不出量级。
2. **冷启动等模型**：检索先 `await` embedding 模型加载。新版本首次在 helper 进程里加载 GGUF 要
   编译 Metal 管线（用户机 `com.j3n5en.enso-code.helper/com.apple.metal` 恰在首查后 3s 落新缓存），
   这一步本身就能超过 15s；闲置卸载后重载同理。

## 修法

- 实体通道先在 `entities` / `entity_aliases` 里求出命中的种子，再 `CROSS JOIN` 沿 `mentions_entity`
  取记忆，固定连接顺序。
- 检索不等模型加载：embedder 还没就绪就只起加载、本次只用全文 + 实体通道返回并带
  `vector: 'warming'`（GGUF 加载有同步段，先等它会连全文检索一起卡住）；已加载的模型
  （含闲置卸载后重载）查询向量 1.5s 内拿不到同样跳过。写入仍等模型，工具超时放宽到 30s。
- 启动 20s 后、库已存在时后台 `warmup`：开库、加载模型、跑一次查询向量。
- deep 的 analyze + rerank 共用一份 LLM 预算（远程 8s），不再串行叠到 16s。
- 客户端 op 超时从调用时起算，服务起不来也不会无限挂起。

残留：GGUF 加载里 Metal 管线编译是同步的，清空 Metal 缓存实测会把服务线程占住约 12s，
这期间到达的检索要排队（仍在 15s 内）。启动预热把这段放到无人检索的时候；彻底消除需把
llama 加载挪出服务主线程。

## 回归防线

- `search.test.ts`「多 space 检索不随『实体数 × 记忆数』放大」（修前 3.3s，修后约 2ms）。
- `search.test.ts` 向量预算两例；`memoryHost.test.ts` 冷加载并发首查、预热两例。
- `memoryServiceClient.test.ts` 冷启动并发合并、起不来按超时失败。
- `searchLlm.test.ts` 共用预算两例；`agent/tools/memory.test.ts` 按操作区分超时。

## 相关代码

- `src/main/services/memory/search.ts`（`entityChannel`、`withinBudget`）
- `src/main/services/memoryServiceCore.ts`（`invokeMemory`、`warmMemoryService`）
- `src/main/services/memoryHost.ts`（`scheduleMemoryServiceWarmup`）
- `src/main/services/memoryServiceClient.ts`、`src/main/services/memory/searchLlm.ts`
