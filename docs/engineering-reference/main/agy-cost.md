# agy provider 的配额与 token 去向

EnsoCode 经 `agy acp` 调 Antigravity。下面的数字来自开发机 2026-11-25 至 11-28 的 55 个 agy 会话，
用 `node scripts/agy-usage-report.mjs` 复算。脚本只读本机日志和会话库，不发请求，不耗配额。

## 不能做的事

- 不传 `agy acp --agent <x>`。`agy acp --help` 里它是“Agent for the ACP session”，二进制里有
  `CHAT_MESSAGE_REQUEST_TYPE_CUSTOM_AGENT`。此前调研称 custom_agent 按 4× 计配额，本地日志没有记请求类型，
  这一倍数未复核。`src/agent/agy/launch.test.ts` 锁住启动参数。
- 不替用户改模型。Orchestrator 的开销只写在这里，选不选由用户决定。

## 钱花在哪

| 项 | 实测 | 谁能改 |
| --- | --- | --- |
| Orchestrator (Neon) 的 executor（`gemini-flash-worker-agy`）| 362 次请求，未缓存输入 12.9M token，占全部未缓存输入约 60%。秘书会话里 41 次 executor 请求各带 4 万到 42 万未缓存 token（合计 9.7M），其中 15 次离上一次 executor 请求不到 5 分钟 | agy 内部，EnsoCode 管不了 |
| 长会话的上下文 | 秘书会话 719 次请求，上下文涨到约 46 万 token，每次请求都带着它（多数命中缓存）| 压缩策略，不在本次范围 |
| 新会话首个请求 | 中位数 2.2 万未缓存 token，55 个会话首请求命中缓存 0 次 | 只有 EnsoCode 挂的工具声明和 append 归我们管 |
| 其中 `mcp_enso_*` 工具声明 | 普通会话 33–35 KB（约 8K token），秘书约 15 KB | `src/shared/agy/hostTools.ts` |
| 其中 session 级 append | 普通会话 3.7–4.0 KB（约 1K token）；秘书会话加上规则约 30 KB | `src/shared/agy/systemAppend.ts` |
| `sir_flash_lite` 安全预审 | 1333 次，`mcp_enso_*` 与 `call_mcp_tool` 占 478 次 | MCP 工具不在 agy 的白名单里，只能少调 |

agy 的预审白名单（二进制内嵌的 `agy_tool_safety` 配置）只认 agy 自己的工具名，比如 `view_file`、`grep_search`、
`update_steps`。任何 `mcp_<server>_<tool>` 都会被判 `unsupported_tool`，再跑一次 Flash-Lite 预审。
`edit_file`、`write_file` 也不在白名单里，裸用 agy 同样要预审，不算 EnsoCode 多出来的。

每次 Enso 工具调用还要多一次主模型请求（agy 把工具结果送回模型才能继续）。在几十万 token 的长会话里，
这一次请求比预审贵得多。

## 预审按工具拆开

| 原因 | 次数 |
| --- | --- |
| `mcp_enso_enso_tool_call`（懒加载工具，绝大多数是秘书 op）| 298 |
| `mcp_enso_enso_tool_search` | 55，其中 49 次在秘书会话，查的是 `session_*`、`cleanup_*`、`silence_turn` 等 schema |
| `mcp_enso_todo` | 28 |
| `mcp_enso_image_view` | 23 |
| `mcp_enso_memory_search` | 20 |

经 `enso_tool_call` 转调的秘书 op 里，`silence_turn` 70 次、`cleanup_apply`/`cleanup_list` 65 次、
`session_list`/`session_archive`/`session_read` 49 次。`todo` 只占 Enso 预审的 6%，不是大头。

## 已做的取舍

- 秘书最常用的 7 个小 op 直挂到 tools/list（约 8.6 KB），省掉调用前的 `enso_tool_search`。秘书会话的 tools/list
  从 12.6 KB 涨到约 21.2 KB，仍在 30 KB 预算的 3/4 以内。`session_create`、`session_send` 单个 3.5–4.7 KB，
  每轮都带的成本不一定抵得过省下的查询，留在懒加载。
- 子代理不复用 agy 会话：resume 会把别人的上下文带进来，改了行为。首请求从不命中缓存，能省的只有工具声明和 append；
  append 约 1K token，且是产品说明的载体，没删。
- `todo` 的提示词没改：两天 28 次预审，降频收益小于改提示词的风险。

## 秘书规则进 append

秘书 / Bot 的人设由 `personaExtension` 换进 pi 不带标签的开头角色段。`ensoSystemAppend` 只按标签取
`addendum`、`preset_tail`、`preset_boost`，开头段因为带 pi 身份句故意不取，人设就一起丢了。
现在人设由桥从 `PersonaHolder` 直接传入，作为 `<role>` 段放在 append 最前。

上限分两层：

- `<role>` 整段保留，从不截断；
- 其余 Enso 段仍按原来的 16 KiB 预算、按 addendum → preset_tail → preset_boost 的顺序在行边界截断，
  且和 `<role>` 合计不超过 40 KiB（agy 在 128 KiB 截断 prompt，回退路径下 append 和当轮用户文字同发）。

没有人设的会话输出逐字节不变。本机秘书档案下规则 26.3 KB，append 从 3.7 KB 变成 30.0 KB，
比旧的 16 KiB 上限多 13.7 KB，超出的就是规则本身。

成本按上面的口径推算：秘书会话两天 719 次请求，append 在每次请求里都带着（多数命中缓存），
首个请求和 54 次缓存重置时按未缓存计。append 每多 1K token，两天约多 0.72M cached 和约 55K 未缓存输入 token。
秘书规则约 6.6K token（按 4 字节/token 估），即约 4.7M cached 和约 0.36M 未缓存，是这个会话未缓存输入（14.7M）的 2.5% 左右。

## 怎么量

```bash
node scripts/agy-usage-report.mjs --since 2026-11-29T00:00          # 改动后的窗口
node scripts/agy-usage-report.mjs --until 2026-11-29T00:00 --json   # 改动前的窗口
```

会话库的字段号是对照多次请求推出来的：`1.4.2` 未命中缓存输入，`1.4.5` 命中缓存输入，`1.4.3` 输出。
配额怎么折算 cached token 没有公开，A/B 时以 `/usage` 的剩余额度为准。
