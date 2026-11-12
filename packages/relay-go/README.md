# enso-relay (Go)

<p align="right"><a href="README.zh-CN.md">简体中文</a></p>

Single-process relay, **protocol-compatible** with the `packages/relay` Cloudflare Worker: HTTP + WebSocket + SQLite, phone PWA embedded. Run the binary; no database service, no Node.

**Recommended self-hosting is still the Cloudflare Worker.** Use this binary when you do not have (or do not want) Cloudflare. Full guide: [`../relay/README.md`](../relay/README.md).

Linux amd64 / arm64 builds are attached to each [GitHub Release](https://github.com/J3n5en/EnsoCode/releases/latest).

## Run

```bash
chmod +x enso-relay-linux-amd64
./enso-relay-linux-amd64
```

Defaults:

- Listen `:8787`
- Database: `relay.sqlite` next to the executable
- Printed localhost / LAN URL is the phone PWA

```text
enso-relay
  listen   http://0.0.0.0:8787
  local    http://127.0.0.1:8787
  lan      http://192.168.1.8:8787
  sqlite   /path/relay.sqlite
```

Set **Settings → Devices → Relay URL** to that URL. Public HTTPS: Caddy, Nginx, or `--tls-cert` / `--tls-key` with no proxy — see [`../relay/README.md`](../relay/README.md#public-https).

```bash
./enso-relay --listen :8787
./enso-relay --db /var/lib/enso-relay/relay.sqlite
./enso-relay --tls-cert cert.pem --tls-key key.pem
```

Env: `RELAY_LISTEN`, `RELAY_DB`, `RELAY_TLS_CERT`, `RELAY_TLS_KEY`.

## Auto-update

GitHub Release builds (version via ldflags) check for a newer release at startup, then every 4 hours. A newer binary is SHA256-checked against `enso-relay-checksums.txt`, replaced, and restarted in-place with `exec` (same PID; systemd-friendly).

`dev` / `go run` builds do not update.

```bash
./enso-relay --auto-update=false          # disable
./enso-relay --update-interval 6h         # interval (minimum 1m)
./enso-relay --update                    # check/install once, then exit
```

- `RELAY_AUTO_UPDATE=0` disables
- `RELAY_UPDATE_INTERVAL=6h`
- `RELAY_UPDATE_REPO` defaults to `J3n5en/EnsoCode`
- `RELAY_GITHUB_TOKEN` optional, for GitHub API rate limits

## Docker

Public image at `ghcr.io/j3n5en/enso-relay` (`linux/amd64`, `linux/arm64`), no login needed. A release tag is published as that version and `latest`; a manual workflow run is tagged `edge` — for trying unreleased builds, not for production.

```bash
docker run -d --name enso-relay --restart unless-stopped \
  -p 8787:8787 \
  -v enso-relay:/data \
  ghcr.io/j3n5en/enso-relay:latest
```

The database is `/data/relay.sqlite` on that volume, and it holds every `pairs` row — the pairing state each device negotiated. Nothing stateful is baked into the image, so an upgrade only replaces the container:

```bash
docker exec enso-relay sh -c 'cat /data/relay.sqlite' > relay.sqlite.bak   # optional; stop the container first for a clean copy
docker pull ghcr.io/j3n5en/enso-relay:latest
docker rm -f enso-relay
docker run -d --name enso-relay --restart unless-stopped -p 8787:8787 -v enso-relay:/data ghcr.io/j3n5en/enso-relay:latest
```

Keep the same `-v enso-relay:/data`. Without `-v` Docker creates a fresh anonymous volume per container, so a recreated container starts empty and the paired devices look lost; the orphaned volume is what `docker system prune` later removes. Pinning a digest (`ghcr.io/j3n5en/enso-relay@sha256:...`) keeps you off a moving `latest`.

The image sets `RELAY_AUTO_UPDATE=0`: self-update inside a container only rewrites the binary in the container filesystem, so pull a new image instead.

## Build from source

Needs Go 1.24+ and pnpm at the repo root (to build the PWA).

```bash
# repo root
./packages/relay-go/sync-frontend.sh
cd packages/relay-go
go test ./...
CGO_ENABLED=0 go build -o enso-relay .
./enso-relay
```

`sync-frontend.sh` builds `packages/phone` and copies `dist` into `frontend/` (`go:embed` at compile time). Without it, a placeholder page is embedded; protocol tests still pass.

Cross-compile:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o enso-relay-linux-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o enso-relay-linux-arm64 .
```

SQLite uses a pure-Go driver (`modernc.org/sqlite`); no CGO.

## Tests

```bash
cd packages/relay-go
go test ./...
go test -race ./...
```
