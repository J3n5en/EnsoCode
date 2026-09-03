# 系统代理：同步 Chromium / fetch / worker

## Goal

用户只开了系统代理（Clash / 系统设置 / PAC）、没有手动导出 `HTTP_PROXY` 时，EnsoCode 的模型请求、OAuth、自动更新、内嵌浏览器和 agent worker / MCP 子进程都能走同一套代理，而不是只有部分通道碰巧直连。

## Requirements

- 代理模式三种，默认 `system`：
  - `system`：跟随操作系统 / PAC
  - `none`：强制直连
  - `custom`：用户填写的代理 URL
- 同一模式必须同时作用在：
  - Electron `session`（应用窗口 + 内嵌浏览器 guest）
  - 主进程 Node `fetch`（provider 测连、拉模型、OAuth）
  - 进程环境变量（`HTTP(S)_PROXY` / `NO_PROXY` / `GRPC_PROXY`），以便 worker 与 MCP stdio 子进程继承
- `NO_PROXY` 合并内置环回/内网名单与启动时继承的 `NO_PROXY`，不能用 live env 当原始快照
- 设置页「通用」可切换模式；自定义 URL 非法时不得静默写成坏代理
- 启动时先应用代理，再 fork agent worker，避免 worker 吃到空 env 快照
- 运行中改设置必须立刻重解析；worker 已启动时也要同步，不能只改父进程
- 旧 `settings.json` 无此字段时按 `system` 处理，不要求用户重配
- 解析失败时保留上一轮可用代理，不要拆掉正在工作的连接池

## Acceptance Criteria

- [ ] 默认模式为系统代理；无系统代理时 Chromium 与 Node fetch 均为直连，且不残留 `HTTP_PROXY`
- [ ] 系统代理解析出 `PROXY host:port` 后，主进程 fetch 与 `process.env.HTTP_PROXY` 指向该地址
- [ ] `none` 清除 Chromium 代理、Node dispatcher 与全部代理环境变量
- [ ] `custom` 仅接受合法 `http(s)://` 代理 URL；非法 URL 不覆盖当前有效配置
- [ ] 启动继承的 `NO_PROXY` 与内置名单合并后写入 dispatcher / env
- [ ] 通用设置页可改模式与自定义 URL，多窗口通过现有 settings persist 同步
- [ ] agent worker 在首次 fork 时带上已解析 env；之后改代理不必重启整个应用才能生效
- [ ] 内嵌浏览器 guest session 与 `defaultSession` 使用同一套代理规则

## Notes

- 参考 DeepChat `src/main/platform/proxy.ts` 的三层同步与排队 resolve，不整文件复制。
- Node `fetch`（undici）对 SOCKS 系统代理没有一等支持：Chromium 仍走系统/自定义规则；Node 侧只把 `PROXY` / `HTTPS` 结果装成 HTTP(S) dispatcher。
- 不在本任务改 electron-updater 的独立代理配置 API；它吃进程 env，跟 env 同步即可。
- 不引入应用级 PAC 编辑器。
