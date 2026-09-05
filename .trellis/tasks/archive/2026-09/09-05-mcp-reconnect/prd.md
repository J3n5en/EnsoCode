# MCP 调用失败时重连一次

## 问题

`McpManager` 把成功建连的 `Client` 缓存到 worker 退出。stdio 桥（如 `zg server --stdio`）在 daemon 重启后会回 `Not connected`，但缓存不失效、工具闭包继续打死连接。新开会话复用同一 worker，现象不变。

DeepChat：`onclose` 标断开，下次 `callTool` 先 `ensureConnected`。
oh-my-pi：`transport.onClose` 自动重连 + 调用失败按可重试错误再连一次。

## 本期范围

只做 OMP 的**调用层 rescue**，不做后台 `onClose` 连打、不做熔断、不做设置页 / `/mcp reconnect`。

1. 识别可重试连接错误（`not connected` / `transport closed` / 常见网络 errno / HTTP 404·502·503）。
2. `execute` 命中后清该 server 缓存、关掉旧 client、再建连，**同一工具只重试一次**。
3. 非可重试错误（业务失败、401）不重连。
4. 同 server 并发失败合并成一次重连。

## 非目标

- 监听 `onclose` 后台自动重连（stdio 易 fork storm）
- 设置页重连按钮、手动 IPC
- 刷新已注入会话的工具列表（工具名集合不变即可）

## 验收

- `Not connected` 后下一次 `callTool` 打到新 client 并成功。
- 业务错误不增加连接次数。
- 重连仍失败只再试一次，把最后一次错误抛出。
