# enso-server run

`enso-server run` 在没有显示器、没有 Electron 窗口的 Node.js 22 进程里跑一轮真实 agent 会话。它走的是桌面和 `enso-server` 同一条链路：`agentHost.spawnSession` / `promptSession` → worker `src/agent/index.ts` → `SessionSupervisor`。模型请求打到配置的供应商，不走模拟回复。

诊断写在 stderr。stdout 只有选定的输出格式。

## 构建

只要无界面宿主，不需要打桌面安装包：

```bash
pnpm install
pnpm build:server:bundle
node out/server/index.js run --help
```

`pnpm build:server` 还会构建桌面 renderer 和手机 PWA，供 `enso-server start --web` 使用。容器里的评测任务用 `build:server:bundle` 即可。产物是 `out/server/index.js`（带 shebang）和旁边的 `out/server/agent.js`。依赖留在 `node_modules`，Node 需要 `>= 22`。

Harbor 适配器见 [`eval/harbor/enso_agent.py`](../eval/harbor/enso_agent.py)。安装脚本 [`eval/harbor/install.sh`](../eval/harbor/install.sh) 会在镜像里装 Node.js 22，并在给出 tarball 时执行 `npm install -g`。

## 示例

```bash
export ENSO_DATA_DIR=/tmp/enso
export ENSO_API_KEY="$OPENAI_API_KEY"
export ENSO_BASE_URL=https://api.openai.com/v1
export ENSO_MODEL=gpt-4o-mini

node out/server/index.js run \
  --prompt 'Add a failing test, then make it pass.' \
  --cwd /workspace \
  --mode full \
  --api openai-completions \
  --output-format json \
  --usage-log /tmp/enso-usage.jsonl \
  --timeout-ms 600000
```

`--prompt @task.md` 从文件读，`--prompt -` 从 stdin 读。`--goal` 和 `--target` 是同一个开关：按桌面 `/goal` 的方式自动续跑，直到模型调用 `goal_complete` / `goal_blocked` / `goal_wait`，或到达轮数上限。

## 参数

| 标志 | 说明 |
| --- | --- |
| `--cwd <dir>` | 工作目录，默认当前目录 |
| `--mode supervised\|auto-edits\|full\|assistant` | 审批档位，默认 `full` |
| `--goal` / `--target <text>` | goal 模式。可以和 `--prompt` 一起用；两者相同则只发 goal 开场 |
| `--auto-turns <n>` | goal 自动轮数上限，默认 25，最大 10000 |
| `--provider <id>` | 供应商 id。只靠标志新建时默认 `enso-run` |
| `--model <id>` | 模型 id |
| `--api <kind>` | `openai-completions`、`openai-responses`、`anthropic-messages`，以及供应商层支持的其它协议 |
| `--api-key <key>` | API key |
| `--base-url <url>` | 模型端点 |
| `--reasoning-effort <level>` | `off` / `none` 或 `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `--timeout-ms <n>` | 整次运行的墙钟上限 |
| `--output-format text\|json\|stream-json` | 默认 `text` |
| `--resume <session id>` | 恢复数据目录里已有的会话 |
| `--continue` | 恢复当前目录最近一次 `run` |
| `--disallowed-tools <list>` | 逗号或空白分隔。`Bash(git *)` 会去掉整个 `bash`。也接受内置组 id，如 `web` |
| `--allow-tools <list>` | 重新打开 run 默认关闭的 `web`、`browser`、`image_generation` |
| `--usage-log <path>` | 用量 JSONL |
| `--data-dir <dir>` | 数据目录，覆盖 `ENSO_DATA_DIR` |

命令行优先于环境变量，环境变量优先于 `settings.json`。

| 变量 | 作用 |
| --- | --- |
| `ENSO_DATA_DIR` | 数据目录，默认 `~/.enso-server` |
| `ENSO_PROVIDER_ID` | 供应商 id |
| `ENSO_MODEL` | 模型 id。未设置时回退 `OPENAI_MODEL` |
| `ENSO_API_KEY` | API key |
| `ENSO_BASE_URL` | 端点。没给时用协议默认端点（OpenAI / Anthropic 官方地址） |
| `ENSO_API` | 协议种类 |
| `ENSO_REASONING_EFFORT` | 推理档位 |
| `ENSO_TIMEOUT_MS` | 超时毫秒 |

`ENSO_API_KEY`、`ENSO_BASE_URL` 都没设置、没指定供应商、但给了模型时，才整组回退厂商变量：先 `OPENAI_API_KEY` + `OPENAI_BASE_URL`，再 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`（后者默认 `anthropic-messages`）。不同厂商的 key 和地址不会混搭；环境里常驻的厂商 key 也不会盖掉 `settings.json` 里已配好的供应商。

已有 `$ENSO_DATA_DIR/settings.json` 的 `enso-settings.state.providers` 会直接用。标志或环境变量给出 key 和 base URL 时，会合并或新建一条供应商，文件权限收成 `0600`。

`run` 始终打开无人值守：按档位本该询问的动作立即拒绝，不会挂起。`full` 下放行几乎所有工具，仍然需要确认的高风险动作会被拒绝并让模型换一条路。`assistant` 需要设置里已经有代审模型，否则按配置错误退出。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 会话正常结束。goal 模式里这表示 `goal_complete` |
| 1 | 会话或 worker 失败 |
| 2 | 参数或配置错误，stdout 为空 |
| 3 | goal 被 `goal_blocked` 或 `goal_wait` 停住 |
| 4 | 自动轮数用尽，或连续无进展 |
| 124 | `--timeout-ms` 到期 |
| 130 | SIGINT / SIGTERM。第二次信号直接退出 |

收到信号或超时后会中止会话、释放 worker，并尽量写完 stdout 和 usage log。worker 若在 2 秒内不退出会被 SIGKILL。工具进程由会话 abort 回收；pi 的 bash 是独立进程组，abort 会拆掉这个进程组。

## 输出

`text` 把最终 assistant 正文写到 stdout，没有正文时改写 goal 的 note。`json` 在结束时写一个对象：

```json
{
  "status": "success",
  "exitCode": 0,
  "exitReason": "finished",
  "sessionId": "…",
  "finalMessage": "…",
  "turns": 1,
  "durationMs": 1200,
  "usage": {
    "input": 10,
    "output": 4,
    "cacheRead": 0,
    "cacheWrite": 0,
    "costUsd": null
  },
  "sessionFile": "…",
  "goal": { "status": "completed", "note": "…" }
}
```

`status` 是 `success`、`error`、`blocked`、`waiting`、`exhausted`、`timeout`、`interrupted` 之一。`costUsd` 为 `null` 表示设置里没有这个模型的价格，不是 0 美元。价格来自 `settings.json` 的 `usageModelPricing`（美元 / 百万 token）。

`stream-json` 是 NDJSON。过程中会有 `assistant.delta`、`tool.call`、`tool.result`、`usage`、`goal`、`status`，最后一行是 `type: "result"`，字段与上面的对象相同。不认识的实现可以忽略未知 `type`。

## 用量日志

`--usage-log` 会清空并重写该文件。每个模型调用一结束就追加一行：

```json
{"type":"call","timestamp":"2026-01-01T00:00:00.000Z","provider":"enso-run","model":"gpt-4o-mini","inputTokens":10,"outputTokens":4,"cacheReadTokens":0,"cacheWriteTokens":0,"costUsd":null}
```

结束时再加一行 `type: "summary"`，字段是合计、`costUsd` 和 `calls`；任何一次调用缺价时 `costUsd` 为 `null`。进程被杀掉时，已经写完的 `call` 行还在；没有 `summary` 时把 `call` 加总即可。

## 出站网络

`run` 不会启动配对中继、内置 web、npm 更新检查，也不会启动插件市场检查和常驻插件。worker 不会为 Antigravity、Devin、Qoder、Cursor 刷新在线模型目录。

默认关掉会自己访问第三方的内置工具：`web`（失败时会访问 `https://mcp.exa.ai`）、`browser`、`image_generation`。需要它们时加 `--allow-tools web,browser,image_generation`。

模型自己执行的 shell 命令仍然可以打开网络。那是任务的一部分，不是 EnsoCode 的遥测。容器若要封网，应在网络策略里只放行模型端点。

## goal 信号

`goal_complete` / `goal_blocked` / `goal_wait` 由 worker 发出 `goal-signal`。续跑状态机不在 worker 里：桌面在 renderer，无界面以前在 `pairSessionHost`。后者以前丢掉这个信号，goal 会一直续到 25 轮。`run` 和无界面 pair 现在都会在信号到达后停止续跑。无进展守卫与桌面相同：最终回复连续 3 次为空或与上一轮相同就暂停，退出码 4，`exitReason` 为 `no-progress`。
