# syntax=docker/dockerfile:1

# 手机 PWA 与架构无关，固定在构建机原生平台编一次，避免 arm64 在 QEMU 里跑 pnpm。
FROM --platform=$BUILDPLATFORM node:22.22.2 AS frontend
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
# 只拷清单，源码改动不重装依赖。phone 的 workspace 闭包是 @enso/pair；
# 全仓 frozen install 还要对上 lockfile 里的 relay importer 和 patches，所以不用 --filter。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/pair/package.json packages/pair/package.json
COPY packages/phone/package.json packages/phone/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY patches/ patches/
# 镜像只嵌入手机 PWA，不需要 Electron / node-pty 等生命周期脚本。
# store 挂成 cache：层缓存没命中时依赖仍在，不必重新下载 1000+ 个包。
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN bash ./packages/relay-go/sync-frontend.sh

# Go 原生交叉编译，不必在 QEMU 里跑一整套 arm64 编译；模块缓存两条腿共用，arm64 不再重复下载。
FROM --platform=$BUILDPLATFORM golang:1.27.4 AS build
WORKDIR /src
ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
COPY packages/relay-go/ ./
COPY --from=frontend /src/packages/relay-go/frontend ./frontend
RUN --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -buildmode=exe \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /enso-relay .

# 证书和时区与架构无关，在构建机原生平台安装，runtime 不再进 QEMU 跑 apk。
FROM --platform=$BUILDPLATFORM alpine:3 AS certs
RUN apk add --no-cache ca-certificates tzdata

FROM alpine:3
COPY --from=certs /etc/ssl/certs /etc/ssl/certs
COPY --from=certs /usr/share/zoneinfo /usr/share/zoneinfo
RUN addgroup -S relay \
 && adduser -S -D -H -u 10001 -G relay relay \
 && mkdir -p /data \
 && chown relay:relay /data
COPY --from=build /enso-relay /enso-relay
# source 标签是 GHCR 把包挂到仓库（首页 Packages 入口）的唯一依据，别删
LABEL org.opencontainers.image.source="https://github.com/J3n5en/EnsoCode" \
      org.opencontainers.image.title="enso-relay" \
      org.opencontainers.image.description="EnsoCode phone relay: single static Go binary, forwards ciphertext only" \
      org.opencontainers.image.licenses="MIT"
USER relay
VOLUME /data
ENV RELAY_DB=/data/relay.sqlite \
    RELAY_LISTEN=:8787 \
    RELAY_AUTO_UPDATE=0
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/healthz
ENTRYPOINT ["/enso-relay"]
