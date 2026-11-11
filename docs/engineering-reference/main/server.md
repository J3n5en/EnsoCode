# EnsoCode Server：宿主核心 / 桌面壳 / Node 壳

目标：EnsoCode 以纯 Node 进程跑在 Linux 上，浏览器（desk 完整版 / 手机 PWA）经 pair 配对使用；关掉所有客户端，排队消息、goal 续跑、卡顿重试、首条标题照常进行。桌面与服务器共用同一份宿主核心。

## 分层

```text
src/main/platform/      平台门面 `@platform` 的接口声明（api.ts / types.ts）
src/main/**（核心）      IPC handler、会话、worker、pair —— 只从 @platform 取进程能力
src/main/desktop/       桌面壳：platform.ts 直接转出 Electron；localUi.ts 注册窗口
src/server/             Node 壳：platform.ts 的 Node 实现、入口、控制 socket
test/stubs/platform.ts  测试平台（转出 electron 桩）
```

- `@platform` 由构建别名决定：electron.vite.config.ts → desktop，vite.server.config.ts → server，vitest → test stub。
- biome `noRestrictedImports` 禁止核心目录 import `electron`；`src/server/electronBoundary.test.ts` 从服务端入口追静态 import 图，触达 `electron` / `?modulePath` 即失败。
- 窗口相关一律经 `services/renderers.ts`（`broadcastToRenderers` / `isMainRenderer` / `localMainContents`）与 `services/uiHost.ts` 的 `LocalUi`；服务端不注册 LocalUi（`localUi() === null`）。
- 浏览器 / computer / 通知 / PDF 窗口 / 更新等桌面能力经 `services/desktopHooks.ts` 注入，服务端为 noop。桌面专属 IPC 在 `ipc/desktop.ts`，只有桌面入口注册。

## 服务端平台实现

app 路径来自 `ENSO_DATA_DIR`（默认 `~/.enso-server`）与 `ENSO_APP_ROOT`；ipcMain 是注册表，由 remoteRenderer 隧道调用；safeStorage 用 userData 下 0600 的 `secret.key` 做 AES-256-GCM；utilityProcess.fork 用 `child_process.fork`，agent worker 的 `workerPort()` 同时兼容 `process.parentPort` 与 `process.send`；shell / 电源 / 通知为日志或 noop。

## 无渲染器时的自动行为

没有本地窗口时 leader 由远端 desk 担任（`refreshRemoteLeadership`）；连远端 desk 都没有就进入 `pairSessionHost` 的 headless 分支，由 Main 接管：

| 行为 | headless 实现 |
| --- | --- |
| 排队消息 / goal 续跑 | `HeadlessSessionRuntime` 跟踪 worker 事件，轮次收束后泵队首或续跑 goal，写回会话并更新 pair 目录 |
| 卡顿重试 | 事件心跳 + 前台命令截止时间；`generationStallTimeoutMin` 超时 abort → retry，3 次放弃（判定函数在 `@shared/stallTimeout`） |
| 首条标题 | 冷会话首条用户消息取代表行；开启标题总结时经 `requestTitleSummary` 请求模型，基准未变才回写 |
| pair 目录 | 平时由 leader 推送；服务端把每次变化防抖落盘到 `pair-catalog.json`，重启先回灌 |
| 自动归档 / 删除 | 仍在 leader 水合时扫描（与桌面“启动时扫一次”一致），任一 desk 连上即执行 |

新装的服务端需先用 desk 连一次，leader 才会推出目录（项目、模型列表）；之后手机端可独立使用。

## Node 壳与分发

- 以 npm 包 `@ensocode/server` 分发：`npm i -g @ensocode/server`（Node 22+）。`pnpm pack:server` 生成 tgz（`--skip-build` 复用已有 `out/`）。
- `vite.server.config.ts` 只把 `package.json` 的 `dependencies` 留作外部依赖，其余（如 devDependencies 里的 `qrcode`）打进产物；`index.js` 带 shebang，直接作为 bin。
- `scripts/pack-server.mjs` 扫描产物里实际 import 的包，生成精简后的 `dependencies`：
  - 打过补丁的 `@earendil-works/pi-coding-agent` 和 `@rahularya01/pi-cursor` 随包放在 `out/node_modules`。产物解析模块时会先命中这里，再往上找包级 `node_modules`。这里不能用 `bundleDependencies`：npm 会把它们的传递依赖也当成随包内容，结果不解压，留下空目录（例如 esbuild 的 install.js 缺失）。
  - `node-pty` 换成 `npm:@lydell/node-pty`：上游包在 Linux 上没有预编译产物，用户机器上不一定有编译工具链。
  - `node-llama-cpp` 不随包，本地 llama 能力缺失时会降级。rtk 也不随包。
- 子命令：`start` 前台运行，`pair | devices | revoke | status | update` 经 `$ENSO_DATA_DIR/server.sock`（0600）操作运行中的宿主。`run` 不启动宿主，直接跑一轮会话，见 [enso-server run](../../enso-server-run.md)。`pair` 在终端打印二维码，并等待配对完成。`service install|uninstall` 写 systemd 单元（root 写系统级，其他用户写用户级），单元里只写 `ENSO_DATA_DIR`、`PATH`。`logs` 调用 journalctl。
- 配置：`$ENSO_DATA_DIR/config.toml`（`src/server/config.ts`），`start` 时只补环境里没设的 `ENSO_*`，所以优先级是参数 > 环境变量 > 文件；未知键或类型不对直接拒绝启动。`service install` 把当时的 `ENSO_RELAY_URL`、`ENSO_NPM_REGISTRY` 和 web 参数写进这个文件而不写死在单元里，并总是 `restart`（已运行时 `enable --now` 不会重启）。旧版本写死在单元里的这些变量会盖过配置文件，`config` 向导检测到会提示重新注册。
- `config` 向导（`src/server/setup/`）：公共中继 / 自己反代（打印 Caddy、nginx 示例）/ 自有域名 + Caddy（先查 A 记录是否指向本机公网 IP）/ `公网IP.nip.io` + Caddy。root 下用系统包管理器装 Caddy，Caddyfile 里只维护带标记的一段（发行版自带的 `:80` 示例整份替换），写前备份为 `.enso-bak`，`caddy validate` 不过就还原；Caddyfile 里已有用户手写的同域名站点时不再追加（否则 Caddy 报 ambiguous site definition）：已转发到本端口就沿用，否则提示手动改。最后探测本机端口和公开地址的 `/healthz`。系统操作经 `SetupSystem` 注入，流程有单测。
- 同一数据目录只允许运行一个宿主：`start` 前先探测控制 socket；`service install` 发现前台实例正在运行时会拒绝安装。
- 服务器上不可用：桌面控制、内嵌浏览器、托盘、系统通知、原生目录选择（远端客户端添加项目时改用对话框内的宿主机目录浏览，`projects:list-host-dirs`，可就地新建文件夹 `projects:create-host-dir`；其他目录选择仍是手输路径）。

## 内置 web（可选）

默认关闭；`enso-server config` 或 `start` / `service install` 给出 `--web`、`--web-host`、`--web-port`、`--public-url` 任一项（或对应 `ENSO_WEB*` / `ENSO_PUBLIC_URL` 环境变量）即开启。

- `src/server/web/relayServer.ts` 在同一端口提供手机 PWA（`out/phone`，源码里回退 `packages/phone/dist`）、`/desk-bundle/<manifest>`（本机 renderer 产物）和中继协议 `/v1/pair/*`，行为对齐 `packages/relay-go`，状态机复用 `packages/relay/src/pairing.ts`；已认领的配对存 `$ENSO_DATA_DIR/relay-pairs.json`（0600）。
- 默认只听 `127.0.0.1:7878`，TLS 交给用户的反向代理（需支持 WebSocket）。手机端的配对加密（`crypto.subtle`）与完整版（service worker）都要求 https 或 localhost，`http://IP` 下完整版不可用。
- 配对链接与设备记录用 `--public-url`；宿主自己经 `pairBuiltinRelay.ts` 把它映射回本机端口拨号，不绕反代。开启后忽略 `ENSO_RELAY_URL`。
- ws 打进产物后 `bufferutil` / `utf-8-validate` 会被替换成空对象，`vite.server.config.ts` 用 `WS_NO_BUFFER_UTIL` / `WS_NO_UTF_8_VALIDATE` 关掉，否则首个入站帧就崩。

## 更新与重启

服务端复用桌面的 `updater:*` 通道（多了 `getState` / `restart`），这些通道只有服务端会开放给远端（`allowRemoteHostControl`）；远端连桌面宿主时仍然拒绝。

- 新版本以 npm registry 上 `@ensocode/server` 的 latest dist-tag 为准（`ENSO_NPM_REGISTRY` 可改）。
- 只有装在可写的全局 `node_modules` 下时才走 `npm` 模式；npx 缓存、源码目录下运行是 `manual`，只报告新版本。
- 下载 = `npm cache add`。应用 = `npm i -g @ensocode/server@<v> --prefer-offline` 然后退出，由 systemd 拉起。全局安装改写的是正在运行的文件（懒加载 chunk 的文件名带 hash），所以真正安装放在退出前一刻。
- 远程重启和"空闲时自动重启"都需要进程守护（systemd 自带 `INVOCATION_ID`，或设置 `ENSO_SUPERVISED=1`）。
- 发布：`.github/workflows/publish-server.yml` 手动触发，独立于桌面端发版（可填版本号、dist-tag、dry-run；预发布版本默认发到 `next`）。走 npm Trusted Publishing（OIDC），不需要 token；npm 包设置里登记的是 `J3n5en/EnsoCode` 的 `publish-server.yml`。workflow_dispatch 只认默认分支上存在的 workflow 文件。
- npm 11 起会对依赖的安装脚本给出警告（npm 12 默认阻止）。真正依赖安装脚本的只有 `@vscode/ripgrep`（下载 rg），缺失时只影响工作区文件搜索。
