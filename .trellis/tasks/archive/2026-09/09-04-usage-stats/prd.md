# Usage statistics dashboard

## Goal

在 EnsoCode 设置窗口新增「用量」页，本地离线统计本应用所有 pi 会话的 token 用量与预估费用，
视觉参考 vibecafe.ai Vibe Usage dashboard（见 `research/vibe-usage-dashboard.png`）。

## Data source

- `userData/agent/sessions/*.jsonl`（pi session v3）。只读；`type:"message"` 且
  `message.role === 'assistant'` 的 `message.usage` 为唯一 token 来源。
- `usage.input` / `output` / `cacheRead` / `cacheWrite` / `reasoning`（reasoning 已含在 output 内）。
- 本应用 `usage.cost` 恒为 0，费用由 Main 侧用 pi catalog（`runtime.getModels()` 的
  `cost` $/M）按 model id 精确匹配估算；匹配不到的模型费用记 `null` 并在 UI 标注「未定价」。
- project = `session.cwd` 的 basename；session 由 `session.id` 标识。
- 活跃时长 = 每轮从 user 消息到该轮最后一条 assistant/toolResult 消息的时间跨度之和。

## Scope (MVP)

1. Main：扫描 + 解析 + 按文件 mtime/size 缓存 + 聚合 → `usage:summary` IPC，入参 `{ days }`（1/7/30/90）。
2. 汇总：总览卡（预估费用、总 Token、输入、输出、缓存、活跃时长、会话数、消息数）+ 相对上一同长周期的变化率；
   每日趋势（输入/输出/缓存堆叠，Token/费用切换）；周×小时活跃热力图；按模型、按项目排行。
3. Renderer：设置分类 `usage`，全部文案走 `t()` 并补中文。

## Non-goals

- 不上传、不同步、不做排行榜；不统计其他 AI 工具；不做远程节点会话。
- 不做自定义单价编辑（后续任务）。

## Acceptance

- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 纯逻辑（解析、聚合、定价、格式化）100% 有测试且遵守 TDD。
- 设置窗口打开「用量」页，真机能看到本机数据（CDP 截图）。

## Result

- 9 commits `d133f2c..HEAD`（shared 逻辑 → parser/IPC → UI → 评审修复）。
- 测试：format 22 / pricing 8 / aggregate 20 + DST 3 / parseSession 17 / usageService 6 / ipc 7，全绿；`pnpm typecheck` 干净，新增文件 biome 干净。
- 真机（隔离 userData，拷贝本机 255 个 session）：设置 → 用量 显示 7 天 $2243 / 1.7B tokens；warm 请求 ~10ms；
  仅 `gemini-3.8-flash-tiered` 无 catalog 单价。
- 后续可做：自定义单价编辑；分时热力图 Token/费用切换；主窗口入口（当前只在设置分类）。
