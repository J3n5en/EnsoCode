# enso-relay（Go）

<p align="right"><a href="README.md">English</a></p>

与 `packages/relay` Cloudflare Worker **协议兼容**的单进程中继：HTTP + WebSocket + SQLite，手机 PWA 打进二进制。双击 / 直接运行，不用装数据库、不用 Node。

**自建仍推荐 Cloudflare Worker。** 没有或不想用 CF 时再用本二进制。完整说明见 [`../relay/README.zh-CN.md`](../relay/README.zh-CN.md)。

Linux amd64 / arm64 随应用 [GitHub Release](https://github.com/J3n5en/EnsoCode/releases/latest) 一起构建，并挂到同一个 Release。

## 运行

```bash
chmod +x enso-relay-linux-amd64
./enso-relay-linux-amd64
```

默认：

- 监听 `:8787`
- 数据库：可执行文件旁 `relay.sqlite`
- 打开打印出的本机 / 局域网 URL 即是手机 PWA

```text
enso-relay
  监听    http://0.0.0.0:8787
  本机    http://127.0.0.1:8787
  局域网  http://192.168.1.8:8787
  数据库  /path/relay.sqlite
```

桌面端 **设置 → 设备 → 中继地址** 填上述 URL。公网 HTTPS：Caddy、Nginx，或不反代用 `--tls-cert` / `--tls-key`，见 [`../relay/README.zh-CN.md`](../relay/README.zh-CN.md#公网-https)。

```bash
./enso-relay --listen :8787
./enso-relay --db /var/lib/enso-relay/relay.sqlite
./enso-relay --tls-cert cert.pem --tls-key key.pem
```

对应环境变量：`RELAY_LISTEN`、`RELAY_DB`、`RELAY_TLS_CERT`、`RELAY_TLS_KEY`。

## 自动更新

GitHub Release 构建（带版本 ldflags）默认开启：启动时检查最新 Release，之后每 4 小时再查。发现新版本会校验 `enso-relay-checksums.txt` 的 SHA256，替换二进制并以同一 PID `exec` 重启（适合 systemd）。

`dev` / `go run` 构建不会更新。

```bash
./enso-relay --auto-update=false          # 关闭
./enso-relay --update-interval 6h         # 改间隔（最短 1 分钟）
./enso-relay --update                    # 只检查/安装一次后退出
```

- `RELAY_AUTO_UPDATE=0` 关闭
- `RELAY_UPDATE_INTERVAL=6h`
- `RELAY_UPDATE_REPO` 默认 `J3n5en/EnsoCode`
- `RELAY_GITHUB_TOKEN` 可选，提高 GitHub API 限额

## Docker

镜像发布到 `ghcr.io/j3n5en/enso-relay`（`linux/amd64` 与 `linux/arm64`）。Release tag 会打上该版本号和 `latest`；手动触发工作流打 `edge`。

```bash
docker run -d -p 8787:8787 -v enso-relay:/data ghcr.io/j3n5en/enso-relay:latest
```

数据库在卷里的 `/data/relay.sqlite`。镜像设置了 `RELAY_AUTO_UPDATE=0`：容器内自更新只是替换容器文件系统里的二进制，没有意义，更新请重新构建或拉取新镜像。

## 从源码构建

需要 Go 1.24+、仓库根目录的 pnpm（用于构建 PWA）。

```bash
# 仓库根目录
./packages/relay-go/sync-frontend.sh
cd packages/relay-go
go test ./...
CGO_ENABLED=0 go build -o enso-relay .
./enso-relay
```

`sync-frontend.sh` 会构建 `packages/phone` 并把 `dist` 拷进 `frontend/`（编译期 `go:embed`）。不跑脚本时嵌入的是占位页，协议测试仍可通过。

交叉编译：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o enso-relay-linux-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o enso-relay-linux-arm64 .
```

SQLite 用纯 Go 驱动（`modernc.org/sqlite`），交叉编译不需要 CGO。

## 开发测试

```bash
cd packages/relay-go
go test ./...
go test -race ./...
```
