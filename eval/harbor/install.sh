#!/usr/bin/env bash
# Install Node.js 22 (if needed) and the EnsoCode server package.
# Usage: install.sh [/path/to/ensocode-server.tgz]
set -euo pipefail

need_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 1 : 0)'
}

# 任务镜像常常是精简版：下载和解压 Node 需要 curl、证书与 xz
ensure_fetch_tools() {
  if command -v curl >/dev/null 2>&1 && command -v xz >/dev/null 2>&1; then
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates xz-utils >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates xz
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates xz
  else
    echo "need curl and xz to install Node.js; unsupported package manager" >&2
    exit 1
  fi
}

if need_node; then
  ensure_fetch_tools
  arch="$(uname -m)"
  case "$arch" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  version="${ENSO_NODE_VERSION:-22.23.4}"
  tarball="node-v${version}-linux-${node_arch}.tar.xz"
  url="https://nodejs.org/dist/v${version}/${tarball}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/$tarball"
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1
  hash -r || true
fi

node -v
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  npm install -g "$1"
fi

if ! command -v enso-server >/dev/null 2>&1; then
  echo "enso-server is not on PATH. Pass the packed server tarball to install.sh." >&2
  exit 1
fi
enso-server run --help >/dev/null
