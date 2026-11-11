# @ensocode/server

EnsoCode 的无界面服务端：跑在 Linux（或 macOS）上，手机 / 浏览器经中继配对后远程使用 agent。

```bash
npm i -g @ensocode/server        # 需要 Node.js 22+
enso-server config           # 可选：问答式选择连接方式（默认公共中继，不配也能用）
enso-server start            # 前台运行
enso-server pair             # 另开终端：扫码或打开链接完成配对
```

后台常驻（systemd，开机自启、崩溃拉起，网页端可一键更新 / 重启）：

```bash
enso-server service install
enso-server status
enso-server logs
```

| 命令 | 说明 |
| --- | --- |
| `config` | 问答式配置：公共中继 / 内置 web + 自己的反代 / 自有域名 + Caddy / 公网 IP.nip.io + Caddy（root 下可自动安装配置 Caddy） |
| `start` | 前台运行 |
| `pair` | 生成配对二维码与链接，等待设备配对 |
| `devices` / `revoke <pairId>` | 查看 / 撤销已配对设备 |
| `status` | 运行状态、版本、更新与设备 |
| `update` | 检查并安装新版本后重启 |
| `service install\|uninstall` | 注册 / 移除 systemd 服务 |
| `logs` | 跟随服务日志 |
| `run` | 不启动宿主，对一个目录跑一轮真实会话。`enso-server run --help` |

设置保存在 `$ENSO_DATA_DIR/config.toml`（`enso-server config` 生成，可手改，改完重启服务生效）：

```toml
relay_url = "https://relay.example.com"   # 自建中继（不开内置 web 时）

[web]
enabled = true
host = "127.0.0.1"
port = 7878
public_url = "https://enso.example.com"
```

环境变量：`ENSO_DATA_DIR`（默认 `~/.enso-server`）、`ENSO_RELAY_URL`、`ENSO_WEB` / `ENSO_WEB_HOST` / `ENSO_WEB_PORT` / `ENSO_PUBLIC_URL`。优先级：命令行参数 > 环境变量 > 配置文件。`service install` 只把 `ENSO_DATA_DIR`、`PATH` 写进服务；当时的 `ENSO_RELAY_URL`、`ENSO_NPM_REGISTRY` 和 web 参数写进配置文件。

单次评测运行不需要 `start`：

```bash
enso-server run --prompt "..." --cwd /workspace --mode full \
  --api openai-completions --output-format json --usage-log /tmp/usage.jsonl
```

供应商可以用 `--api-key`、`--base-url`、`--model`，或 `ENSO_API_KEY`、`ENSO_BASE_URL`、`ENSO_MODEL`（也接受 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 和对应的 `*_BASE_URL`）。退出码、JSON 和用量日志见仓库 `docs/enso-server-run.md`。

## 内置 web（可选）

默认手机经公共中继连接。也可以让服务自己提供网页与中继，手机直接访问你的域名：

```bash
enso-server start --public-url https://enso.example.com   # 默认只听 127.0.0.1:7878
```

手机端需要 https，请用反向代理（需支持 WebSocket）对外提供，例如 Caddy：

```
enso.example.com {
    reverse_proxy 127.0.0.1:7878
}
```

参数：`--web`、`--web-host`、`--web-port`、`--public-url`（给出任一即开启），对应环境变量 `ENSO_WEB=1`、`ENSO_WEB_HOST`、`ENSO_WEB_PORT`、`ENSO_PUBLIC_URL`；`service install` 同样接受这些参数。更省事的做法是 `enso-server config`。
