<p align="center">
  <img src="build/icons/256x256.png" width="120" alt="EnsoCode" />
</p>

<h1 align="center">EnsoCode</h1>

<p align="center">
  <b>一个人，带一队 Coding Agent</b>
</p>

<p align="center">
  <a href="https://github.com/J3n5en/EnsoCode/releases/latest"><b>下载</b></a>
  ·
  <a href="https://enso.j3.do/">官网</a>
  ·
  <a href="https://t.me/EnsoAI_news">更新频道</a>
  ·
  <a href="https://t.me/EnsoCode_Official">讨论群组</a>
  ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/J3n5en/EnsoCode/releases/latest"><img src="https://img.shields.io/github/v/release/J3n5en/EnsoCode?label=release" alt="Latest release" /></a>
  <a href="https://github.com/J3n5en/EnsoCode/releases"><img src="https://img.shields.io/github/downloads/J3n5en/EnsoCode/total?label=downloads" alt="Downloads" /></a>
  <a href="https://github.com/J3n5en/EnsoCode/stargazers"><img src="https://img.shields.io/github/stars/J3n5en/EnsoCode?style=flat&label=stars" alt="Stars" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-555?style=flat-square" alt="macOS, Windows, Linux" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/J3n5en/EnsoCode" alt="MIT" /></a>
</p>

<p align="center">
  <img src="docs/readme/chat.jpg" alt="EnsoCode 工作台：桌面端与手机伴侣" width="920" />
</p>
<p align="center"><sub>同一会话两块屏幕：桌面工作台和手机伴侣。</sub></p>

> 购物车等着上「第二件半价」，数据库慢查询在报警，设计系统的样式还没统一——侧栏挂入多个仓库，一件事一个会话，Agent 并行开工。补丁、命令与目标摊在时间线上，你只管把控和验收。
> 人离开工位也不断线：审批与回合进度实时推到手机，路上点一下，Agent 接着干。

---

## 为什么是 EnsoCode

EnsoCode 是基于 Electron 和 [pi](https://github.com/earendil-works/pi) 的本地桌面 Agent 工作台。它负责**调度、监督、协同一队专职 Agent**，而不是一次回答一个问题。

- **分活有边界**：仓库挂在侧栏，一件事一个会话；同仓库并行可选用 Git Worktree（`enso/*`），互不踩踏。
- **任务分级派发**：一次性任务派 **Subagent**（独立上下文，交报告即销毁）；长线协作雇 **Coworker**（专属 Tab、持久记忆，随时插话）。
- **改动摊在时间线**：Diff 嵌在对话流里。三档审批（全程审批 / 自动接受编辑 / 完全放行），加上 Git Checkpoint 一键回滚。
- **离座不断线**：扫码配对 PWA 手机伴侣。端到端加密，中继只转发密文。
- **远程干活**：原生 SSH 项目，或把另一台 EnsoCode 桌面配成 Remote Node。
- **把已有资产带过来**：一键导入本机 Claude Code / Codex / Cursor 的配置、密钥、MCP 和历史会话。

---

## 五步开始验收

1. **下载** [GitHub Releases](https://github.com/J3n5en/EnsoCode/releases/latest) 最新安装包。
2. **接入模型**：打开设置，或从 Claude Code / Codex / Cursor 导入。
3. **侧栏挂入仓库**。
4. **开一个会话。** 一次性活派 Subagent，长线活雇 Coworker。
5. **看结果。** 审 Diff、切审批档位，改乱了就回滚 Checkpoint。

不需要 EnsoCode 账号。模型请求直达你配置的供应商。

---

## 核心能力

### 1. 分工调度

| 模式 | 做什么 |
| :--- | :--- |
| **多项目 & 多会话** | 侧栏聚合多个本地仓库。每会话独立时间线、模型、预设，可置顶与归档。 |
| **Git Worktree 隔离** | 默认在主工作树；可切到 `enso/*` worktree 做并行分支。 |
| **Subagent** | 一次性工人（`scout` / `tester` / `reviewer` / `worker` …），独立上下文，交报告即退出。 |
| **Coworker** | 长期同事，住在自己的 Tab。旁观、插话、追问，不污染父会话上下文。 |
| **后台进程** | Dev Server、Watch、长构建以胶囊挂在输入框上方。 |

### 2. 审查、安全、快照

| 能力 | 做什么 |
| :--- | :--- |
| **内嵌 Diff** | 读文件、打补丁、改代码在对话流或侧栏展开。 |
| **三档审批** | 全程逐项审批 / 自动接受编辑 / 完全放行，运行中可切换。 |
| **Git Checkpoint** | 破坏性写入前打快照到 `refs/enso-checkpoints`（每会话最多 50 个）。 |

### 3. 长任务跟得上

| 能力 | 做什么 |
| :--- | :--- |
| **目标跟踪（`/goal`）** | 把结果钉在顶部。Agent 自动推进（最多 25 轮），随时暂停或继续。 |
| **插话队列** | 执行中可排队补充；能改能丢，紧急则立即打断。 |
| **瞬态重试** | 网络抖动或供应商 5xx 自动倒计时重试。 |
| **可停靠侧栏** | 文件树、会话改动、分栏终端、内嵌浏览器。 |

<p align="center">
  <img src="docs/readme/split-workbench.png" alt="侧栏：文件、改动、终端、浏览器" width="920" />
</p>
<p align="center"><sub>文件、改动、终端、浏览器贴在会话旁边。</sub></p>

### 4. 手机伴侣与远程节点

- **手机伴侣**：扫码即连。翻历史、审批、回答提问、插话。中继只见密文。
- **桌面 Remote Node**：两台 EnsoCode 配对，在轻薄本上操作另一台机器上的会话。
- **SSH 项目**：经 SSH 直接打远端目录，不必把仓库镜像到本地。
- **自建服务端**：宿主跑在你自己的 Linux 或 macOS 上。客户端都关掉后，排队消息和 goal 继续跑；手机或浏览器配对后使用。见[无界面服务端](#无界面服务端)。

<p align="center">
  <img src="docs/readme/phone.png" alt="扫码配对手机伴侣" width="920" />
</p>
<p align="center"><sub>几秒配对。加密密钥留在设备上。</sub></p>

### 5. 扩展与个性化

| 能力 | 做什么 |
| :--- | :--- |
| **技能、MCP、Slash、`@`** | `/skill:` 胶囊，`@` 联想文件和会话，多 MCP 服务。 |
| **运行时预设** | 把模型策略、技能、MCP、系统 Prompt 打成一套。 |
| **导入** | 扫描本机 Claude Code / Codex / Cursor，导入密钥、技能、MCP、指令和历史。 |
| **外观** | Ghostty 终端配色、浅色/深色、背景图、毛玻璃。 |
| **状态栏** | Token、费用、耗时、上下文用量、Coworker 数、审批档位。 |

<p align="center">
  <img src="docs/readme/appearance.png" alt="外观：主题与终端配色" width="920" />
</p>
<p align="center"><sub>主题、Ghostty 配色、实时预览。</sub></p>

---

## Local-first，说清楚

本地优先不等于「永远不联网」。

| 数据 | 去向 |
| :--- | :--- |
| 会话 | 本机 JSONL |
| 设置 | 本机应用数据 |
| API 密钥 | 本机设置（只在 Main）。不会发到手机目录 |
| 配对密钥 | 系统加密存储（可用时） |
| SSH 密码 | 系统钥匙串 |
| EnsoCode 遥测 | 无 |
| 模型请求 | 直达你配置的供应商或 Endpoint |
| 手机 / 远程节点 | 可选。默认中继只转发**密文**；同一局域网可直连 |
| 自建服务端 | 可选。会话和设置留在那台机器（默认 `~/.enso-server`） |

不需要 EnsoCode 账号，也没有 Enso 托管的模型中转。若使用远程模型，请求上下文会发给该供应商，按其隐私政策处理。手机伴侣是可选项：不配对，除你发起的模型调用外，没有数据离开桌面。

---

## 下载

**[下载最新版本 →](https://github.com/J3n5en/EnsoCode/releases/latest)**

| 平台 | 安装包 |
| :--- | :--- |
| macOS | `.dmg`（Apple Silicon / Intel） |
| Windows | `EnsoCode-Setup-<version>.exe` |
| Linux | `.AppImage` / `.deb` |

### 无界面服务端

[`@ensocode/server`](https://www.npmjs.com/package/@ensocode/server) 是没有界面的 EnsoCode 宿主，agent 在它上面跑；它不是手机中继，中继只转发密文。需要 Node.js 22+。

```bash
npm i -g @ensocode/server
enso-server config   # 可选：选择客户端连接方式
enso-server start
enso-server pair     # 另开终端：扫码或打开链接完成配对
```

`enso-server service install` 注册 systemd 服务（仅 Linux：开机自启、崩溃拉起）。完整命令见 [scripts/server-package/README.md](scripts/server-package/README.md)。

- 新装后，项目和模型目录要等完整版（浏览器 desk）连上并推送一次才会出现。之后手机可以单独用；宿主重启后沿用上次推送的快照。
- 服务器上没有桌面控制、内嵌浏览器、托盘、系统通知。
- 浏览器完整版需要 https 或 localhost。
- 数据在这台机器上（默认 `~/.enso-server`），没有 EnsoCode 账号。

---

## 本地开发

<details>
<summary><strong>从源码运行 EnsoCode</strong></summary>

<br />

**环境：** Node.js `>= 22`，[pnpm](https://pnpm.io) `>= 10`。

```bash
pnpm install
pnpm dev
```

```bash
pnpm build:mac    # .dmg / .zip
pnpm build:win    # .exe
pnpm build:linux  # .AppImage / .deb
```

```bash
pnpm typecheck
pnpm lint
pnpm test
```

</details>

<details>
<summary><strong>自建手机中继</strong></summary>

<br />

默认公共中继是 `https://enso-relay.j3.do`。要自己跑，见 [packages/relay/README.zh-CN.md](packages/relay/README.zh-CN.md)：

- **Cloudflare Worker**（推荐）：`pnpm --filter @enso/relay release`。
- **Go 单二进制**：从 GitHub Release 下载 `enso-relay-linux-amd64` / `enso-relay-linux-arm64`，`chmod +x` 后运行。

桌面端 **设置 → 设备 → 中继地址** 改成你的 URL。

</details>

---

## 链接

- 官网：[enso.j3.do](https://enso.j3.do/)
- 安装包：[github.com/J3n5en/EnsoCode/releases](https://github.com/J3n5en/EnsoCode/releases/latest)
- 更新频道：[t.me/EnsoAI_news](https://t.me/EnsoAI_news)
- 讨论群组：[t.me/EnsoCode_Official](https://t.me/EnsoCode_Official)

---

## 友链

- [Linux.Do](https://linux.do/) — 与社区一起分享、讨论、关注开发进展。

---

## 开源许可

MIT。见 [LICENSE](LICENSE)。
