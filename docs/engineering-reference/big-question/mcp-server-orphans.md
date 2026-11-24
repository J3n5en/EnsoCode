# 应用退出 / 更新后 stdio MCP server 一直活着，旧版 crashpad_handler 也退不掉

## 症状

`ps` 里有 ppid=1 的 `HopperMCPServer`、`npm exec rea-agents mcp`，pgid 是某一代早已退出的 EnsoCode 主进程，
stdin/stdout 的 socket 对端已是 `(none)`；那一代的 `chrome_crashpad_handler` 因为它们继承了异常端口也一直不退。
`worker-exits.log` 里每次退出都是 `code=0`，看不出 worker 被强杀。

## 根因

- SDK 的 `StdioClientTransport` 把 server 放在应用的进程组里，`close()` 先关 stdin 等 2 秒，再只给**直接子进程** SIGTERM。
  HopperMCPServer 之类不理 stdin EOF，只有走到 SIGTERM 这一步才会退；`npx` 外壳下面的真实 server 从来收不到信号。
- worker 的收尾是 server 唯一的退出途径。应用退出 / 安装更新时 Electron 直接结束还在收尾的 utilityProcess，
  SIGTERM 处理函数跑不完，`exit` 照样报 `code=0`（实测）；worker 超时被 SIGKILL、崩溃、应用被强杀同理。没人再回收这些 server。

## 修法

- `src/agent/mcpStdio.ts`：POSIX 上 server 用 `detached` 自立进程组；断开时关 stdin 等 0.5 秒，再对整棵树
  （`signalProcessTree`）SIGTERM、1 秒后 SIGKILL。Windows 仍用 SDK transport。
- worker 把每个 server 的 pid + 启动时间（`ps lstart`）和自己的 pid + 启动时间登记在 `agent/mcp-servers/`；
  Main 在 worker `exit` 时（刚退出的那个 worker 直接算不在，Electron 报 exit 时它可能还在进程表里）和启动 worker 前清扫：
  只结束 pid 与启动时间都对得上、登记者已不在的 server 整棵树，用户自己起的同名进程不会被认成。
- 插件宿主收子进程改成 `killProcessTree`，没 detached 的子进程派生的孙进程（与宿主同组）逐个发信号。

## 回归防线

- `src/agent/mcpStdio.test.ts`（假 server 派生孙进程、登记与撤销、强杀后清扫、pid 复用不误杀、登记者在世不碰）
- `src/pluginHost/host.test.ts`「子进程派生的孙进程在 shutdown 后也退出」
- `src/agent/killTree.test.ts`「ownGroupDescendants」
